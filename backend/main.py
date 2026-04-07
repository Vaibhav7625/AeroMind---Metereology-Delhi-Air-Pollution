from fastapi import FastAPI
from pydantic import BaseModel
import pickle
import numpy as np
import requests
from datetime import datetime, timezone, timedelta
from fastapi.middleware.cors import CORSMiddleware
import time
from dotenv import load_dotenv
import os

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== LOAD MODELS =====
pm25_model = pickle.load(open("xg_pm25/xgboost_model.pkl", "rb"))
pm10_model = pickle.load(open("xg_pm10/xgboost_model.pkl", "rb"))
o3_model   = pickle.load(open("xg_o3/xgboost_model.pkl", "rb"))

# ===== STATIONS =====
STATIONS_META = {
    "RK Puram":     {"lat": 28.563262, "lon": 77.186937, "loc_id": 17,   "encoded": 0},
    "Punjabi Bagh": {"lat": 28.674045, "lon": 77.131023, "loc_id": 50,   "encoded": 1},
    "Anand Vihar":  {"lat": 28.646835, "lon": 77.316032, "loc_id": 235,  "encoded": 2},
    "Jahangirpuri": {"lat": 28.73282,  "lon": 77.170633, "loc_id": 8235, "encoded": 3},
    "Okhla":        {"lat": 28.530785, "lon": 77.271255, "loc_id": 8239, "encoded": 4},
    "Nehru Nagar":  {"lat": 28.56789,  "lon": 77.250515, "loc_id": 8365, "encoded": 5},
    "Bawana":       {"lat": 28.7762,   "lon": 77.051074, "loc_id": 8472, "encoded": 6},
}

FALLBACK_VALUES = {
    "RK Puram":     {"pm25": 110, "pm10": 160, "o3": 55},
    "Punjabi Bagh": {"pm25": 95,  "pm10": 140, "o3": 48},
    "Anand Vihar":  {"pm25": 140, "pm10": 200, "o3": 60},
    "Jahangirpuri": {"pm25": 125, "pm10": 180, "o3": 52},
    "Okhla":        {"pm25": 100, "pm10": 150, "o3": 50},
    "Nehru Nagar":  {"pm25": 118, "pm10": 170, "o3": 58},
    "Bawana":       {"pm25": 135, "pm10": 195, "o3": 45},
}

OAQ_KEY = os.getenv("OAQ_API_KEY")
HEADERS = {"X-API-Key": OAQ_KEY}

POLLUTION_CACHE = {"data": None, "ts": 0}
WEATHER_CACHE   = {"data": None, "ts": 0}


class SimulateInput(BaseModel):
    station: str
    temp: float
    wind: float
    pressure: float
    dew: float
    blh: float


# ──────────────────────────────────────────────────────────────────────────
# OPENAQ HELPERS
# ──────────────────────────────────────────────────────────────────────────

def oaq_get(url: str, params: dict = None):
    try:
        r = requests.get(url, headers=HEADERS, params=params, timeout=10)
        print(f"  OAQ {r.status_code}  {url}  params={params}")
        if r.status_code != 200:
            return None
        return r.json()
    except Exception as e:
        print(f"  OAQ failed: {e}")
        return None


def get_sensors_for_location(loc_id: int) -> list:
    data = oaq_get(f"https://api.openaq.org/v3/locations/{loc_id}")
    if not data or not data.get("results"):
        return []

    sensors = data["results"][0].get("sensors", [])
    selected = []
    for s in sensors:
        pname = s["parameter"]["name"].lower()
        units = s["parameter"].get("units", "")
        if pname in ("pm25", "pm10", "o3") and "µg" in units:
            selected.append({
                "sensor_id": s["id"],
                "parameter": pname,
            })
    return selected


def fetch_sensor_hours(sensor_id: int, limit: int = 8) -> list:
    now_utc  = datetime.now(timezone.utc)
    date_to  = now_utc.strftime("%Y-%m-%d")
    date_from = (now_utc - timedelta(days=3)).strftime("%Y-%m-%d")

    data = oaq_get(
        f"https://api.openaq.org/v3/sensors/{sensor_id}/hours",
        params={
            "date_from": date_from,
            "date_to":   date_to,
            "limit":     limit,
            "order_by":  "datetime",
            "sort":      "desc",
        }
    )
    if not data or not data.get("results"):
        return []

    values = [
        item["value"]
        for item in data["results"]
        if item.get("value") is not None
    ]
    values.reverse()
    return values


def fetch_latest_for_location(loc_id: int) -> dict:
    result  = {}
    sensors = get_sensors_for_location(loc_id)

    if not sensors:
        print(f"  No µg sensors found for loc_id={loc_id}")
        return result

    for s in sensors:
        sid   = s["sensor_id"]
        pname = s["parameter"]

        if pname in result:
            continue

        hours = fetch_sensor_hours(sid, limit=8)
        if not hours:
            print(f"  No hourly data for sensor {sid} ({pname})")
            continue

        result[pname] = float(hours[-1])

        if pname == "pm25":
            result["pm25_history"] = hours

    return result


# ──────────────────────────────────────────────────────────────────────────
# FETCH ALL STATIONS
# ──────────────────────────────────────────────────────────────────────────

def fetch_pollution() -> dict:
    if POLLUTION_CACHE["data"] and time.time() - POLLUTION_CACHE["ts"] < 300:
        return POLLUTION_CACHE["data"]

    data_out = {}

    for name, meta in STATIONS_META.items():
        print(f"\nFetching {name} (loc_id={meta['loc_id']})…")
        live = fetch_latest_for_location(meta["loc_id"])
        fb   = FALLBACK_VALUES[name]

        pm25 = live.get("pm25") or fb["pm25"]
        pm10 = live.get("pm10") or fb["pm10"]
        o3   = live.get("o3")   or fb["o3"]
        hist = live.get("pm25_history") or [pm25] * 7

        data_out[name] = {
            "lat":          meta["lat"],
            "lon":          meta["lon"],
            "pm25":         pm25,
            "pm10":         pm10,
            "o3":           o3,
            "pm25_history": hist,
            "source":       "live" if live else "fallback",
        }

    POLLUTION_CACHE["data"] = data_out
    POLLUTION_CACHE["ts"]   = time.time()
    return data_out


# ──────────────────────────────────────────────────────────────────────────
# FETCH WEATHER
# ──────────────────────────────────────────────────────────────────────────

def fetch_weather() -> dict:
    if WEATHER_CACHE["data"] and time.time() - WEATHER_CACHE["ts"] < 600:
        return WEATHER_CACHE["data"]

    try:
        url = (
            "https://api.open-meteo.com/v1/forecast"
            "?latitude=28.61&longitude=77.20"
            "&current=temperature_2m,wind_speed_10m,surface_pressure,dew_point_2m"
            "&hourly=boundary_layer_height&forecast_days=1"
        )
        res = requests.get(url, timeout=8).json()
        cur = res.get("current", {})
        blh_list = res.get("hourly", {}).get("boundary_layer_height", [500])
        blh = next((v for v in blh_list if v is not None), 500)

        weather = {
            "temp":     cur.get("temperature_2m", 28),
            "wind":     cur.get("wind_speed_10m", 8),
            "pressure": cur.get("surface_pressure", 1010),
            "dew":      cur.get("dew_point_2m", 18),
            "blh":      round(blh),
        }
    except Exception as e:
        print("Weather fetch error:", e)
        weather = {"temp": 28, "wind": 8, "pressure": 1010, "dew": 18, "blh": 500}

    WEATHER_CACHE["data"] = weather
    WEATHER_CACHE["ts"]   = time.time()
    return weather


# ──────────────────────────────────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────────────────────────────────

def get_lags(history: list, fallback: float):
    h = list(history)
    while len(h) < 7:
        h.insert(0, fallback)
    return h[-1], h[-2], h[-3], float(np.mean(h[-3:])), float(np.mean(h[-7:]))


def get_season(month: int) -> int:
    if month in (12, 1, 2): return 0   # Winter
    if month in (3, 4, 5):  return 1   # Pre-monsoon
    if month == 6:           return 2   # Early monsoon
    if month in (7, 8, 9):  return 3   # Monsoon
    return 4                            # Post-monsoon


# ──────────────────────────────────────────────────────────────────────────
# AQI — CPCB sub-index breakpoints (India standard)
# Pollutants: PM2.5 (µg/m³ 24h), PM10 (µg/m³ 24h), O3 (µg/m³ 8h)
# Using hourly readings as proxy for 24h/8h averages (acceptable for
# a real-time dashboard / college project approximation)
# ──────────────────────────────────────────────────────────────────────────

# Each entry: (concentration_breakpoint, aqi_breakpoint)
BREAKPOINTS = {
    "pm25": [
        (0,    0),
        (30,   50),
        (60,   100),
        (90,   200),
        (120,  300),
        (250,  400),
        (float("inf"), 500),
    ],
    "pm10": [
        (0,    0),
        (50,   50),
        (100,  100),
        (250,  200),
        (350,  300),
        (430,  400),
        (float("inf"), 500),
    ],
    "o3": [
        (0,    0),
        (50,   50),
        (100,  100),
        (168,  200),
        (208,  300),
        (748,  400),
        (float("inf"), 500),
    ],
}


def linear_interpolate(cp, breakpoints):
    """CPCB linear interpolation between breakpoints."""
    for i in range(1, len(breakpoints)):
        c_hi, aqi_hi = breakpoints[i]
        c_lo, aqi_lo = breakpoints[i - 1]
        if cp <= c_hi:
            # Linear interpolation
            return aqi_lo + (aqi_hi - aqi_lo) * (cp - c_lo) / (c_hi - c_lo)
    return 500


def sub_index(value: float, pollutant: str) -> float:
    """Returns CPCB sub-index for a single pollutant."""
    return linear_interpolate(max(0, value), BREAKPOINTS[pollutant])


def calculate_aqi(pm25: float, pm10: float, o3: float) -> int:
    """
    CPCB AQI: compute sub-index for each pollutant, return the max.
    Reference: CPCB AQI Technical Document (2014).
    """
    si_pm25 = sub_index(pm25, "pm25")
    si_pm10 = sub_index(pm10, "pm10")
    si_o3   = sub_index(o3,   "o3")
    return int(max(si_pm25, si_pm10, si_o3))


def aqi_category(aqi: int) -> str:
    if aqi <= 50:  return "Good"
    if aqi <= 100: return "Moderate"
    if aqi <= 200: return "Unhealthy for Sensitive"
    if aqi <= 300: return "Unhealthy"
    if aqi <= 400: return "Very Unhealthy"
    return "Hazardous"


def build_features(
    station: str,
    temp: float, dew: float, pressure: float, blh: float, wind: float,
    pm25_history: list, current_pm25: float, current_o3: float, current_pm10: float,
    now: datetime,
) -> np.ndarray:
    """
    17-feature vector in training order:
      o3, pm10, year, month, temp, dew, pressure, blh, wind,
      day, season, station_encoded,
      pm25_lag1, pm25_lag2, pm25_lag3, pm25_roll3, pm25_roll7
    """
    lag1, lag2, lag3, roll3, roll7 = get_lags(pm25_history, current_pm25)
    season          = get_season(now.month)
    station_encoded = STATIONS_META[station]["encoded"]

    return np.array([[
        current_o3,
        current_pm10,
        now.year,
        now.month,
        temp,
        dew,
        pressure,
        blh,
        wind,
        now.day,
        season,
        station_encoded,
        lag1,
        lag2,
        lag3,
        roll3,
        roll7,
    ]])


# ──────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ──────────────────────────────────────────────────────────────────────────

@app.get("/current")
def get_current():
    pollution = fetch_pollution()
    weather   = fetch_weather()

    stations_out = {}
    for name, vals in pollution.items():
        aqi = calculate_aqi(vals["pm25"], vals["pm10"], vals["o3"])
        stations_out[name] = {
            "lat":      vals["lat"],
            "lon":      vals["lon"],
            "pm25":     round(vals["pm25"], 1),
            "pm10":     round(vals["pm10"], 1),
            "o3":       round(vals["o3"],   1),
            "aqi":      aqi,
            "category": aqi_category(aqi),
            "source":   vals.get("source", "unknown"),
        }

    return {
        "stations": stations_out,
        "weather":  weather,
        "updated":  datetime.now().isoformat(),
    }


@app.post("/simulate")
def simulate(data: SimulateInput):
    pollution = fetch_pollution()
    weather   = fetch_weather()          # current real weather for bias baseline

    if data.station not in pollution:
        return {"error": f"Station '{data.station}' not found"}

    vals    = pollution[data.station]
    pm25_r  = vals["pm25"]
    pm10_r  = vals["pm10"]
    o3_r    = vals["o3"]
    history = vals.get("pm25_history", [pm25_r] * 7)
    now     = datetime.now()

    # ── 1. Predict at slider (user-chosen) weather ──────────────────────
    sim_features = build_features(
        station      = data.station,
        temp         = data.temp,
        dew          = data.dew,
        pressure     = data.pressure,
        blh          = data.blh,
        wind         = data.wind,
        pm25_history = history,
        current_pm25 = pm25_r,
        current_o3   = o3_r,
        current_pm10 = pm10_r,
        now          = now,
    )
    pm25_sim = float(pm25_model.predict(sim_features)[0])
    pm10_sim = float(pm10_model.predict(sim_features)[0])
    o3_sim   = float(o3_model.predict(sim_features)[0])

    # ── 2. Predict at CURRENT real weather (bias baseline) ──────────────
    base_features = build_features(
        station      = data.station,
        temp         = weather["temp"],
        dew          = weather["dew"],
        pressure     = weather["pressure"],
        blh          = weather["blh"],
        wind         = weather["wind"],
        pm25_history = history,
        current_pm25 = pm25_r,
        current_o3   = o3_r,
        current_pm10 = pm10_r,
        now          = now,
    )
    pm25_base = float(pm25_model.predict(base_features)[0])
    pm10_base = float(pm10_model.predict(base_features)[0])
    o3_base   = float(o3_model.predict(base_features)[0])

    # ── 3. Bias correction: anchor model output to real current values ───
    # When sliders == current weather, predicted == real (delta == 0).
    # When sliders change, predicted reflects the relative model response.
    pm25_p = pm25_sim + (pm25_r - pm25_base)
    pm10_p = pm10_sim + (pm10_r - pm10_base)
    o3_p   = o3_sim   + (o3_r   - o3_base)

    # Clamp to non-negative (concentrations can't go below 0)
    pm25_p = max(0.0, pm25_p)
    pm10_p = max(0.0, pm10_p)
    o3_p   = max(0.0, o3_p)

    aqi_p  = calculate_aqi(pm25_p, pm10_p, o3_p)
    aqi_c  = calculate_aqi(pm25_r, pm10_r, o3_r)

    return {
        "station": data.station,
        "predicted": {
            "pm25":     round(pm25_p, 1),
            "pm10":     round(pm10_p, 1),
            "o3":       round(o3_p,   1),
            "aqi":      aqi_p,
            "category": aqi_category(aqi_p),
        },
        "current": {
            "pm25":     round(pm25_r, 1),
            "pm10":     round(pm10_r, 1),
            "o3":       round(o3_r,   1),
            "aqi":      aqi_c,
            "category": aqi_category(aqi_c),
        },
        "delta": {
            "pm25": round(pm25_p - pm25_r, 1),
            "pm10": round(pm10_p - pm10_r, 1),
            "o3":   round(o3_p   - o3_r,   1),
            "aqi":  aqi_p - aqi_c,
        },
    }


@app.get("/debug")
def debug():
    """Visit http://localhost:8000/debug to check live sensor data per station."""
    report = {}
    for name, meta in STATIONS_META.items():
        sensors = get_sensors_for_location(meta["loc_id"])
        live    = fetch_latest_for_location(meta["loc_id"])
        report[name] = {
            "loc_id":        meta["loc_id"],
            "sensors_found": sensors,
            "live":          live,
            "fallback":      FALLBACK_VALUES[name],
        }
    return report