import React, { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const AQI_COLORS = {
  "Good":                       { fill: "#00e676", glow: "#00e676" },
  "Moderate":                   { fill: "#ffea00", glow: "#ffea00" },
  "Unhealthy for Sensitive":    { fill: "#ff9800", glow: "#ff9800" },
  "Unhealthy":                  { fill: "#f44336", glow: "#f44336" },
  "Very Unhealthy":             { fill: "#9c27b0", glow: "#9c27b0" },
  "Hazardous":                  { fill: "#7b1fa2", glow: "#7b1fa2" },
};

function getColor(category) {
  return AQI_COLORS[category] || { fill: "#90a4ae", glow: "#90a4ae" };
}

function PulseMarker({ station, data, onClick, isSelected }) {
  const coords = [data.lat, data.lon];
  const color = getColor(data.category);
  const r = isSelected ? 22 : 16;

  return (
    <CircleMarker
      center={coords}
      radius={r}
      pathOptions={{
        fillColor: color.fill,
        fillOpacity: 0.9,
        color: isSelected ? "#fff" : color.fill,
        weight: isSelected ? 3 : 1.5,
      }}
      eventHandlers={{ click: () => onClick(station) }}
    >
      <Popup className="aqi-popup">
        <strong>{station}</strong><br />
        AQI: {data.aqi} — {data.category}
      </Popup>
    </CircleMarker>
  );
}

export default function MapView({ stations, selectedStation, onSelectStation }) {
  return (
    <MapContainer
      center={[28.61, 77.20]}
      zoom={11}
      style={{ height: "100%", width: "100%", background: "#0a0e1a" }}
      zoomControl={false}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
      />
      {Object.entries(stations || {}).map(([name, data]) => (
        <PulseMarker
          key={name}
          station={name}
          data={data}
          onClick={onSelectStation}
          isSelected={selectedStation === name}
        />
      ))}
    </MapContainer>
  );
}