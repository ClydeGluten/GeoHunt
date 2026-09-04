import type { PlayzonePolygon, VisiblePosition } from "@geohunter/contracts";
import type { FeatureCollection } from "geojson";
import maplibregl, {
  type GeoJSONSource,
  type Map as MapLibreMap,
  Marker,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";

interface MapViewProps {
  polygon: PlayzonePolygon | null;
  positions?: VisiblePosition[];
  editable?: boolean;
  onPolygonChange?: (polygon: PlayzonePolygon | null) => void;
}

const styleUrl =
  import.meta.env.VITE_MAP_STYLE_URL ||
  "https://tiles.openfreemap.org/styles/liberty";

function markerLabel(position: VisiblePosition): string {
  const accuracy = `±${Math.round(position.accuracyMeters)} m`;
  if (!position.frozen) return `${position.displayName} · ${accuracy}`;
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(position.recordedAt).getTime()) / 1_000),
  );
  const age =
    ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`;
  return `${position.displayName} · last seen ${age} · ${accuracy}`;
}

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function MapView({
  polygon,
  positions = [],
  editable = false,
  onPolygonChange,
}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const vertexMarkers = useRef<Marker[]>([]);
  const ready = useRef(false);
  const polygonRef = useRef(polygon);
  const callbackRef = useRef(onPolygonChange);
  polygonRef.current = polygon;
  callbackRef.current = onPolygonChange;

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: styleUrl,
      center: [66.9, 48.0],
      zoom: 4,
      attributionControl: {
        compact: true,
        customAttribution:
          '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
      },
      cooperativeGestures: false,
    });
    map.current = instance;
    instance.addControl(
      new maplibregl.NavigationControl({ showCompass: true }),
      "top-right",
    );
    instance.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showAccuracyCircle: true,
      }),
      "top-right",
    );
    instance.on("load", () => {
      ready.current = true;
      instance.addSource("playzone", {
        type: "geojson",
        data: emptyCollection(),
      });
      instance.addLayer({
        id: "playzone-fill",
        type: "fill",
        source: "playzone",
        paint: { "fill-color": "#ffb84d", "fill-opacity": 0.16 },
      });
      instance.addLayer({
        id: "playzone-line",
        type: "line",
        source: "playzone",
        paint: {
          "line-color": "#ffb84d",
          "line-width": 3,
          "line-dasharray": [2, 1],
        },
      });
      instance.addSource("players", {
        type: "geojson",
        data: emptyCollection(),
      });
      instance.addLayer({
        id: "player-accuracy",
        type: "circle",
        source: "players",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            4,
            18,
            ["min", 80, ["get", "accuracy"]],
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.1,
          "circle-stroke-width": 0,
        },
      });
      instance.addLayer({
        id: "players-dot",
        type: "circle",
        source: "players",
        paint: {
          "circle-radius": 8,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#071813",
          "circle-stroke-width": 3,
          "circle-opacity": ["case", ["get", "frozen"], 0.55, 1],
        },
      });
      instance.addLayer({
        id: "players-label",
        type: "symbol",
        source: "players",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 12,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#eafff7",
          "text-halo-color": "#071813",
          "text-halo-width": 2,
        },
      });
    });

    const click = (event: maplibregl.MapMouseEvent) => {
      if (!editable || !callbackRef.current) return;
      const current = polygonRef.current?.coordinates[0]?.slice(0, -1) ?? [];
      const next: [number, number][] = [
        ...current,
        [event.lngLat.lng, event.lngLat.lat],
      ];
      if (next.length < 3)
        callbackRef.current({
          type: "Polygon",
          coordinates: [
            [...next, next[0] ?? [event.lngLat.lng, event.lngLat.lat]],
          ],
        });
      else
        callbackRef.current({
          type: "Polygon",
          coordinates: [[...next, next[0] as [number, number]]],
        });
    };
    instance.on("click", click);
    return () => {
      instance.off("click", click);
      vertexMarkers.current.forEach((marker) => marker.remove());
      instance.remove();
      map.current = null;
      ready.current = false;
    };
  }, [editable]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const update = () => {
      const source = instance.getSource("playzone") as
        GeoJSONSource | undefined;
      source?.setData(
        polygon
          ? { type: "Feature", properties: {}, geometry: polygon }
          : emptyCollection(),
      );
    };
    if (ready.current) update();
    else instance.once("load", update);
  }, [polygon]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const update = () => {
      const colors: Record<string, string> = {
        HOST: "#ffffff",
        HIDER: "#48e5a4",
        SEEKER: "#ff6b55",
        SPECTATOR: "#a3b8b0",
      };
      const source = instance.getSource("players") as GeoJSONSource | undefined;
      source?.setData({
        type: "FeatureCollection",
        features: positions.map((position) => ({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [position.longitude, position.latitude],
          },
          properties: {
            label: markerLabel(position),
            color: colors[position.role],
            accuracy: position.accuracyMeters,
            frozen: position.frozen,
          },
        })),
      });
    };
    if (ready.current) update();
    else instance.once("load", update);
  }, [positions]);

  useEffect(() => {
    const instance = map.current;
    vertexMarkers.current.forEach((marker) => marker.remove());
    vertexMarkers.current = [];
    if (!instance || !editable || !polygon?.coordinates[0]) return;
    const vertices = polygon.coordinates[0].slice(0, -1);
    vertexMarkers.current = vertices.map((coordinate, index) => {
      const element = document.createElement("button");
      element.className = "vertex-marker";
      element.type = "button";
      element.setAttribute("aria-label", `Playzone vertex ${index + 1}`);
      const marker = new maplibregl.Marker({ element, draggable: true })
        .setLngLat(coordinate)
        .addTo(instance);
      marker.on("dragend", () => {
        const point = marker.getLngLat();
        const current = polygonRef.current?.coordinates[0]?.slice(0, -1) ?? [];
        const next = current.map((item, itemIndex) =>
          itemIndex === index
            ? ([point.lng, point.lat] as [number, number])
            : item,
        );
        if (next.length)
          callbackRef.current?.({
            type: "Polygon",
            coordinates: [[...next, next[0] as [number, number]]],
          });
      });
      return marker;
    });
  }, [editable, polygon]);

  return <div className="map" ref={container} aria-label="Game map" />;
}
