"""OpenTimelineIO export service: build a timeline from the payload the API sends, write it, and READ IT BACK with the
library to check what a video editor would see (clip order, source ranges, speed, markers, total duration)."""
import json

import opentimelineio as otio
import pytest
from fastapi.testclient import TestClient

from otio_service.build import build_timeline, inspect_timeline
from otio_service.server import app

FPS = {"num": 30, "den": 1}


def payload(**over):
    p = {
        "name": "session ses_1",
        "rate": FPS,
        "source": {"name": "original.mp4", "sha256": "ab" * 32, "duration_units": 6000, "has_video": True, "has_audio": True},
        # output order: the second block of the source comes first (a reorder), the first block is sped up 2x
        "clips": [
            {"name": "clip 1", "src_start": 3000, "out_duration": 900, "speed": {"num": 1, "den": 1}, "src_start_us": 100_000_000, "src_end_us": 130_000_000},
            {"name": "clip 2", "src_start": 300, "out_duration": 450, "speed": {"num": 2, "den": 1}, "src_start_us": 10_000_000, "src_end_us": 40_000_000},
        ],
        "markers": [{"name": "Welcome!", "start": 30, "duration": 60, "color": "#ff0000", "kind": "caption", "text": "Welcome!", "effect_id": "fx_1_1"}],
        "metadata": {"timeline_hash": "cd" * 32, "ai_generated": False},
    }
    p.update(over)
    return p


def test_round_trip_through_the_library_keeps_order_ranges_speed_markers_and_duration():
    tl = build_timeline(payload())
    text = otio.adapters.write_to_string(tl, "otio_json")
    back = otio.adapters.read_from_string(text, "otio_json")
    video = [t for t in back.tracks if t.kind == otio.schema.TrackKind.Video][0]
    clips = list(video.find_clips())
    assert [c.name for c in clips] == ["clip 1", "clip 2"]
    assert [c.source_range.start_time.value for c in clips] == [3000, 300]
    assert [c.source_range.duration.value for c in clips] == [900, 450]
    assert all(c.source_range.start_time.rate == 30 for c in clips)
    # the track is the output timeline: its length is the sum of the output durations
    assert video.duration().value == 1350
    assert back.duration().rescaled_to(30).value == 1350
    # speed is a LinearTimeWarp on the sped-up clip only
    assert len(clips[0].effects) == 0
    assert [type(e).__name__ for e in clips[1].effects] == ["LinearTimeWarp"]
    assert clips[1].effects[0].time_scalar == 2.0
    # captions are markers on the track, at output time
    assert [(m.name, m.marked_range.start_time.value, m.marked_range.duration.value) for m in video.markers] == [("Welcome!", 30, 60)]
    assert video.markers[0].color == otio.schema.MarkerColor.RED
    assert video.markers[0].metadata["incubrix"]["kind"] == "caption"
    # the audio track mirrors the video clips
    audio = [t for t in back.tracks if t.kind == otio.schema.TrackKind.Audio][0]
    assert [c.source_range.start_time.value for c in audio.find_clips()] == [3000, 300]
    assert back.metadata["incubrix"]["timeline_hash"] == "cd" * 32


def test_exact_values_survive_in_clip_metadata():
    tl = build_timeline(payload())
    c = list(tl.video_tracks()[0].find_clips())[1]
    assert c.metadata["incubrix"] == {"src_start_us": 10_000_000, "src_end_us": 40_000_000, "speed": {"num": 2, "den": 1}}


def test_slow_motion_and_ntsc_rate():
    p = payload(rate={"num": 30000, "den": 1001}, clips=[{"name": "slow", "src_start": 0, "out_duration": 60, "speed": {"num": 1, "den": 2}, "src_start_us": 0, "src_end_us": 1_001_000}], markers=[])
    back = otio.adapters.read_from_string(otio.adapters.write_to_string(build_timeline(p), "otio_json"), "otio_json")
    clip = list(back.video_tracks()[0].find_clips())[0]
    assert clip.effects[0].time_scalar == 0.5
    assert clip.source_range.start_time.rate == pytest.approx(30000 / 1001)
    assert back.duration().rescaled_to(30000 / 1001).value == pytest.approx(60)


def test_audio_only_source_has_no_video_track_and_no_rate_means_microseconds():
    p = payload(rate=None, source={"name": "a.m4a", "sha256": "ab" * 32, "duration_units": 10_000_000, "has_video": False, "has_audio": True}, markers=[],
                clips=[{"name": "c", "src_start": 1_000_000, "out_duration": 2_000_000, "speed": {"num": 1, "den": 1}, "src_start_us": 1_000_000, "src_end_us": 3_000_000}])
    back = otio.adapters.read_from_string(otio.adapters.write_to_string(build_timeline(p), "otio_json"), "otio_json")
    assert back.video_tracks() == []
    assert back.duration().to_seconds() == pytest.approx(2.0)


def test_empty_timeline_is_valid():
    back = otio.adapters.read_from_string(otio.adapters.write_to_string(build_timeline(payload(clips=[], markers=[])), "otio_json"), "otio_json")
    assert back.duration().value == 0


def test_output_is_deterministic():
    a = otio.adapters.write_to_string(build_timeline(payload()), "otio_json")
    b = otio.adapters.write_to_string(build_timeline(payload()), "otio_json")
    assert a == b


def test_http_export_then_inspect():
    c = TestClient(app)
    assert c.get("/health").json()["status"] == "ok"
    r = c.post("/export", json=payload())
    assert r.status_code == 200
    assert json.loads(r.text)["OTIO_SCHEMA"].startswith("Timeline")
    info = c.post("/inspect", content=r.content).json()
    assert info["duration_units"] == 1350 and info["rate"] == 30
    v = [t for t in info["tracks"] if t["kind"] == "Video"][0]
    assert [(x["start"], x["duration"], x["time_scalar"]) for x in v["clips"]] == [(3000, 900, 1.0), (300, 450, 2.0)]
    assert v["markers"][0]["name"] == "Welcome!"


def test_bad_payload_and_bad_otio_are_json_errors():
    c = TestClient(app)
    r = c.post("/export", json={"name": "x"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_FAILED"
    r = c.post("/export", json=payload(clips=[{"name": "c", "src_start": 0, "out_duration": -5, "speed": {"num": 1, "den": 1}, "src_start_us": 0, "src_end_us": 1}]))
    assert r.status_code == 400
    r = c.post("/inspect", content=b"not otio")
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_FAILED"


def test_inspect_function_matches_http():
    assert inspect_timeline(build_timeline(payload()))["duration_units"] == 1350
