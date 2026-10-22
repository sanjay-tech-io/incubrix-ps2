"""Turns the payload the API builds from a materialized timeline into an OpenTimelineIO timeline, and reads one back.

Conventions (documented in docs/REVIEW_M5.md):
- Time values are integers in "units": frames of `rate`, or microseconds when `rate` is null (an audio-only source).
- A clip's source_range is (start in the source, duration in the OUTPUT). With a LinearTimeWarp of time_scalar s the clip
  reads s * duration of source, so the track length is exactly the rendered length and the cumulative frame rounding of
  the engine is kept. The exact source span in microseconds is also kept in the clip metadata ("incubrix").
- Captions (and other effects) are markers on the track, at output time.
"""
from typing import Optional

import opentimelineio as otio

MICROS = 1_000_000

# nearest-colour mapping for the fixed OTIO marker palette
PALETTE = {
    "RED": (255, 0, 0), "ORANGE": (255, 165, 0), "YELLOW": (255, 255, 0), "GREEN": (0, 160, 0), "CYAN": (0, 255, 255),
    "BLUE": (0, 0, 255), "PURPLE": (128, 0, 128), "MAGENTA": (255, 0, 255), "PINK": (255, 192, 203), "BLACK": (0, 0, 0), "WHITE": (255, 255, 255),
}


def marker_color(hex_color: Optional[str]) -> str:
    if not hex_color or not hex_color.startswith("#") or len(hex_color) != 7:
        return "WHITE"
    try:
        rgb = tuple(int(hex_color[i : i + 2], 16) for i in (1, 3, 5))
    except ValueError:
        return "WHITE"
    return min(PALETTE, key=lambda n: sum((a - b) ** 2 for a, b in zip(PALETTE[n], rgb)))


def _rate(p: dict) -> float:
    r = p.get("rate")
    return float(MICROS) if r is None else r["num"] / r["den"]


def _clip(p: dict, c: dict, rate: float, ref: otio.schema.ExternalReference) -> otio.schema.Clip:
    clip = otio.schema.Clip(
        name=c["name"],
        media_reference=ref.clone(),
        source_range=otio.opentime.TimeRange(otio.opentime.RationalTime(c["src_start"], rate), otio.opentime.RationalTime(c["out_duration"], rate)),
    )
    sp = c["speed"]
    if sp["num"] != sp["den"]:
        clip.effects.append(otio.schema.LinearTimeWarp(name="speed", time_scalar=sp["num"] / sp["den"], metadata={"incubrix": {"speed": sp}}))
    clip.metadata["incubrix"] = {"src_start_us": c["src_start_us"], "src_end_us": c["src_end_us"], "speed": sp}
    return clip


def build_timeline(p: dict) -> otio.schema.Timeline:
    rate = _rate(p)
    src = p["source"]
    tl = otio.schema.Timeline(name=p["name"])
    tl.global_start_time = otio.opentime.RationalTime(0, rate)
    tl.metadata["incubrix"] = {**p.get("metadata", {}), "source_sha256": src["sha256"], "source_name": src["name"], "exporter": f"opentimelineio {otio.__version__}"}
    ref = otio.schema.ExternalReference(
        target_url=src["name"],
        available_range=otio.opentime.TimeRange(otio.opentime.RationalTime(0, rate), otio.opentime.RationalTime(src["duration_units"], rate)),
        metadata={"incubrix": {"sha256": src["sha256"]}},
    )
    kinds = []
    if src["has_video"]:
        kinds.append((otio.schema.TrackKind.Video, "V1"))
    if src["has_audio"]:
        kinds.append((otio.schema.TrackKind.Audio, "A1"))
    for kind, name in kinds:
        track = otio.schema.Track(name=name, kind=kind)
        for c in p["clips"]:
            track.append(_clip(p, c, rate, ref))
        tl.tracks.append(track)
    # markers go on the first track (the picture when there is one)
    if tl.tracks:
        for m in p["markers"]:
            marker = otio.schema.Marker(
                name=m["name"],
                marked_range=otio.opentime.TimeRange(otio.opentime.RationalTime(m["start"], rate), otio.opentime.RationalTime(m["duration"], rate)),
                color=getattr(otio.schema.MarkerColor, marker_color(m.get("color"))),
                metadata={"incubrix": {k: v for k, v in m.items() if k in ("kind", "text", "effect_id", "detail")}},
            )
            tl.tracks[0].markers.append(marker)
    return tl


def _py(v):
    """OTIO metadata comes back as C++ dictionary/list wrappers; plain Python values are needed to serialise or compare."""
    if hasattr(v, "keys"):
        return {k: _py(v[k]) for k in v.keys()}
    if isinstance(v, (list, tuple)) or type(v).__name__.endswith("AnyVector"):
        return [_py(x) for x in v]
    return v


def inspect_timeline(tl: otio.schema.Timeline) -> dict:
    """What a reader of the file sees. Used by the tests to check the exported file with the library."""
    dur = tl.duration()
    out = {"name": tl.name, "rate": dur.rate, "duration_units": dur.value, "metadata": _py(tl.metadata.get("incubrix", {})), "otio_version": otio.__version__, "tracks": []}
    for t in tl.tracks:
        out["tracks"].append({
            "name": t.name,
            "kind": str(t.kind),
            "duration_units": t.duration().value,
            "clips": [{
                "name": c.name, "start": c.source_range.start_time.value, "duration": c.source_range.duration.value,
                "time_scalar": c.effects[0].time_scalar if c.effects else 1.0,
                "src_start_us": _py(c.metadata.get("incubrix", {})).get("src_start_us"), "src_end_us": _py(c.metadata.get("incubrix", {})).get("src_end_us"),
            } for c in t.find_clips()],
            "markers": [{"name": m.name, "start": m.marked_range.start_time.value, "duration": m.marked_range.duration.value, "color": str(m.color), "kind": _py(m.metadata.get("incubrix", {})).get("kind")} for m in t.markers],
        })
    return out
