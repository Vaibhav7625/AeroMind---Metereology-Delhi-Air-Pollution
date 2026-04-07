import React, { useEffect, useState, useCallback, useRef } from "react";
import MapView from "./components/MapView";
import "./App.css";

const API = "http://localhost:8000";

const AQI_META = {
  "Good":                    { color: "#00e676", bg: "rgba(0,230,118,0.12)",  icon: "🌿" },
  "Moderate":                { color: "#ffea00", bg: "rgba(255,234,0,0.12)",  icon: "😐" },
  "Unhealthy for Sensitive": { color: "#ff9800", bg: "rgba(255,152,0,0.12)", icon: "⚠️" },
  "Unhealthy":               { color: "#f44336", bg: "rgba(244,67,54,0.12)", icon: "😷" },
  "Very Unhealthy":          { color: "#9c27b0", bg: "rgba(156,39,176,0.12)",icon: "🚫" },
  "Hazardous":               { color: "#7b1fa2", bg: "rgba(123,31,162,0.18)",icon: "☠️" },
};

function aqiMeta(cat) {
  return AQI_META[cat] || { color: "#90a4ae", bg: "rgba(144,164,174,0.1)", icon: "❓" };
}

// ── Slider ────────────────────────────────────────────────────────────────
function Slider({ label, unit, value, min, max, step = 1, onChange, description }) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="slider-group">
      <div className="slider-header">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{value}<span className="slider-unit"> {unit}</span></span>
      </div>
      <div className="slider-track-wrap">
        <div className="slider-track-fill" style={{ width: `${pct}%` }} />
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="slider-input"
        />
      </div>
      <div className="slider-desc">{description}</div>
    </div>
  );
}

// ── Pollutant card ────────────────────────────────────────────────────────
function PollCard({ name, current, predicted, unit = "µg/m³" }) {
  const hasSim  = predicted != null;
  const delta   = hasSim ? Math.round((predicted - current) * 10) / 10 : null;
  const simColor = delta == null ? "" : delta > 0 ? "var(--red)" : delta < 0 ? "var(--green)" : "var(--text-dim)";

  return (
    <div className="poll-card">
      <div className="poll-name">{name}</div>
      <div className="poll-current">
        {Math.round(current)}
        <span className="poll-unit"> {unit}</span>
      </div>
      {hasSim && (
        <div className="poll-sim-row">
          <span className="poll-arrow">→</span>
          <span className="poll-predicted">{Math.round(predicted)}</span>
          {delta !== 0 && (
            <span className="poll-delta" style={{ color: simColor }}>
              {delta > 0 ? `+${delta}` : delta}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function WeatherChip({ icon, label, value }) {
  return (
    <div className="weather-chip">
      <span className="wx-icon">{icon}</span>
      <div>
        <div className="wx-label">{label}</div>
        <div className="wx-value">{value}</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [currentData,  setCurrentData]  = useState(null);
  const [selectedStn,  setSelectedStn]  = useState(null);
  const [simResult,    setSimResult]    = useState(null);
  const [simLoading,   setSimLoading]   = useState(false);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [lastUpdated,  setLastUpdated]  = useState(null);
  const debounceRef = useRef(null);

  const [sliders, setSliders] = useState({
    temp: 28, wind: 8, pressure: 1010, dew: 18, blh: 500,
  });

  // ── Fetch current data ──────────────────────────────────────────────────
  const fetchCurrent = useCallback(async () => {
    try {
      const res = await fetch(`${API}/current`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCurrentData(data);
      if (data.weather) {
        setSliders({
          temp:     data.weather.temp,
          wind:     data.weather.wind,
          pressure: data.weather.pressure,
          dew:      data.weather.dew,
          blh:      data.weather.blh,
        });
      }
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(`Cannot reach backend: ${e.message} — is uvicorn running on :8000?`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCurrent(); }, [fetchCurrent]);
  useEffect(() => {
    const id = setInterval(fetchCurrent, 300_000);
    return () => clearInterval(id);
  }, [fetchCurrent]);

  // ── Run simulation ─────────────────────────────────────────────────────
  const runSim = useCallback(async (station, s) => {
    if (!station) return;
    setSimLoading(true);
    try {
      const res = await fetch(`${API}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ station, ...s }),
      });
      const data = await res.json();
      if (data.error) {
        console.error("Simulate error:", data.error);
        setSimResult(null);
      } else {
        setSimResult(data);
      }
    } catch (e) {
      console.error("Simulate fetch failed:", e);
      setSimResult(null);
    } finally {
      setSimLoading(false);
    }
  }, []);

  // Run sim immediately when station changes or sliders change (debounced 350ms)
  useEffect(() => {
    if (!selectedStn) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSim(selectedStn, sliders), 350);
    return () => clearTimeout(debounceRef.current);
  }, [sliders, selectedStn, runSim]);

  // Clear sim result when station deselected
  useEffect(() => {
    if (!selectedStn) setSimResult(null);
  }, [selectedStn]);

  const handleSlider = key => val => setSliders(s => ({ ...s, [key]: val }));

  const resetWeather = () => {
    if (currentData?.weather) {
      setSliders({
        temp:     currentData.weather.temp,
        wind:     currentData.weather.wind,
        pressure: currentData.weather.pressure,
        dew:      currentData.weather.dew,
        blh:      currentData.weather.blh,
      });
    }
  };

  const selData  = selectedStn && currentData?.stations?.[selectedStn];
  const meta     = selData ? aqiMeta(selData.category) : null;
  const simPred  = simResult?.predicted;
  const simDelta = simResult?.delta;

  // ═══════════════════════════════════════════════════════════════════════
  return (
    <div className="app">

      {/* HEADER */}
      <header className="app-header">
        <div className="header-brand">
          <span className="brand-dot" />
          <span className="brand-name">DelhiAQ</span>
          <span className="brand-tag">Air Quality Intelligence</span>
        </div>
        <div className="header-meta">
          {lastUpdated && (
            <span className="last-updated">
              Updated {lastUpdated.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button className="refresh-btn" onClick={fetchCurrent} title="Refresh data">
            {loading ? "…" : "⟳"}
          </button>
        </div>
      </header>

      {error && <div className="error-banner">⚠ {error}</div>}

      <div className="main-layout">

        {/* LEFT PANEL */}
        <aside className="left-panel">
          <div className="panel-section">
            <div className="section-title">Monitoring Stations</div>
            <div className="station-list">
              {loading
                ? Array.from({ length: 7 }).map((_, i) => <div key={i} className="station-row skeleton" />)
                : Object.entries(currentData?.stations || {}).map(([name, d]) => {
                    const m = aqiMeta(d.category);
                    const active = selectedStn === name;
                    return (
                      <button
                        key={name}
                        className={`station-row ${active ? "active" : ""}`}
                        onClick={() => setSelectedStn(prev => prev === name ? null : name)}
                        style={active ? { borderLeftColor: m.color, background: m.bg } : {}}
                      >
                        <span className="stn-dot" style={{ background: m.color }} />
                        <span className="stn-name">{name}</span>
                        <div className="stn-right">
                          <span className="stn-aqi" style={{ color: m.color }}>{d.aqi}</span>
                          <span className="stn-icon">{m.icon}</span>
                          {d.source === "fallback" && (
                            <span className="stn-fallback" title="Using fallback data">est.</span>
                          )}
                        </div>
                      </button>
                    );
                  })
              }
            </div>
          </div>

          <div className="panel-section">
            <div className="section-title">AQI Scale</div>
            <div className="legend">
              {Object.entries(AQI_META).map(([cat, m]) => (
                <div key={cat} className="legend-row">
                  <span className="legend-dot" style={{ background: m.color }} />
                  <span>{m.icon} {cat}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* MAP */}
        <div className="map-wrap">
          {loading
            ? <div className="map-loading"><div className="spinner" /><span>Loading live data…</span></div>
            : <MapView
                stations={currentData?.stations || {}}
                selectedStation={selectedStn}
                onSelectStation={s => setSelectedStn(prev => prev === s ? null : s)}
              />
          }

          {currentData?.weather && (
            <div className="weather-bar">
              <WeatherChip icon="🌡️" label="Temp"     value={`${currentData.weather.temp}°C`} />
              <WeatherChip icon="💨" label="Wind"     value={`${currentData.weather.wind} km/h`} />
              <WeatherChip icon="🔽" label="Pressure" value={`${currentData.weather.pressure} hPa`} />
              <WeatherChip icon="💧" label="Dew Pt."  value={`${currentData.weather.dew}°C`} />
              <WeatherChip icon="↕️" label="BLH"      value={`${currentData.weather.blh} m`} />
            </div>
          )}
        </div>

        {/* RIGHT PANEL */}
        <aside className="right-panel">
          {!selectedStn ? (
            <div className="placeholder-msg">
              <div className="placeholder-icon">📍</div>
              <div>Click any station on the map or list to see live readings and run the weather simulator</div>
            </div>
          ) : (
            <>
              {/* Station header */}
              <div className="station-header" style={{ borderBottomColor: meta?.color }}>
                <div className="sth-top">
                  <span className="sth-name">{selectedStn}</span>
                  {selData?.source === "fallback" && (
                    <span className="badge-fallback">estimated</span>
                  )}
                </div>
                <div className="sth-aqi" style={{ color: meta?.color, background: meta?.bg }}>
                  AQI {selData?.aqi}
                </div>
                <div className="sth-cat">{meta?.icon} {selData?.category}</div>
              </div>

              {/* Pollutants — live vs simulated side by side */}
              <div className="readings-section">
                <div className="section-title" style={{ padding: "12px 16px 0" }}>
                  Live Readings {simPred && <span className="sim-arrow-label">→ Simulated</span>}
                </div>
                <div className="poll-grid">
                  <PollCard name="PM2.5" current={selData?.pm25} predicted={simPred?.pm25} />
                  <PollCard name="PM10"  current={selData?.pm10} predicted={simPred?.pm10} />
                  <PollCard name="O₃"   current={selData?.o3}   predicted={simPred?.o3}   unit="ppb" />
                </div>

                {/* Simulated AQI result */}
                {simPred ? (
                  <div
                    className="sim-aqi-bar"
                    style={{
                      background:   aqiMeta(simPred.category).bg,
                      borderColor:  aqiMeta(simPred.category).color,
                    }}
                  >
                    <div className="sim-aqi-left">
                      <span className="sim-label">Simulated AQI</span>
                      <span className="sim-val" style={{ color: aqiMeta(simPred.category).color }}>
                        {simPred.aqi}
                      </span>
                    </div>
                    <div className="sim-aqi-right">
                      {simDelta?.aqi !== 0 && (
                        <span className={`sim-delta ${simDelta.aqi > 0 ? "delta-up" : "delta-down"}`}>
                          {simDelta.aqi > 0 ? `▲ +${simDelta.aqi}` : `▼ ${simDelta.aqi}`}
                        </span>
                      )}
                      <span className="sim-cat">{aqiMeta(simPred.category).icon} {simPred.category}</span>
                    </div>
                    {simLoading && <div className="sim-spinner">⟳</div>}
                  </div>
                ) : (
                  <div className="sim-pending">
                    {simLoading
                      ? <span><span className="sim-spinner">⟳</span> Running model…</span>
                      : <span>Adjust sliders below to see XGBoost predictions</span>
                    }
                  </div>
                )}
              </div>

              {/* Simulator */}
              <div className="sim-section">
                <div className="sim-header">
                  <span className="section-title" style={{ margin: 0 }}>Weather Simulator</span>
                  <button className="reset-btn" onClick={resetWeather} title="Reset to live weather">
                    ↺ Reset to Live
                  </button>
                </div>
                <div className="sim-note">
                  Drag sliders to change meteorological conditions — the XGBoost model predicts how pollutant levels respond in real time.
                </div>

                <Slider
                  label="Temperature" unit="°C"
                  value={sliders.temp} min={-5} max={50} step={0.5}
                  onChange={handleSlider("temp")}
                  description="Higher temp → better convective mixing → lower PM2.5"
                />
                <Slider
                  label="Wind Speed" unit="km/h"
                  value={sliders.wind} min={0} max={60} step={0.5}
                  onChange={handleSlider("wind")}
                  description="Stronger wind disperses pollutants horizontally"
                />
                <Slider
                  label="Pressure" unit="hPa"
                  value={sliders.pressure} min={990} max={1030} step={0.5}
                  onChange={handleSlider("pressure")}
                  description="High pressure → atmospheric subsidence → traps pollutants"
                />
                <Slider
                  label="Dew Point" unit="°C"
                  value={sliders.dew} min={-10} max={35} step={0.5}
                  onChange={handleSlider("dew")}
                  description="Higher dew point → humid air → promotes particle growth"
                />
                <Slider
                  label="Boundary Layer Height" unit="m"
                  value={sliders.blh} min={50} max={3000} step={10}
                  onChange={handleSlider("blh")}
                  description="Deeper mixing layer dilutes emissions into larger volume"
                />
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}