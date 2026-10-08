#!/usr/bin/env python3
"""
Smoke test for the CTS Route Planner API (v2).

8 Tuen Mun test locations, as a 5-tonne truck, with per-stop service times.
Verifies: optimized order, fuel cost, per-stop breakdown, total delivery
time + 7-hour check, and that XLSX/CSV/MD/JSON are written.

Run the server first:  python server.py
Then:                  python test_route.py [--port 8777]
"""
import argparse
import json
import urllib.request

STOPS = [
    {"name": "Tuen Mun Hospital (front door)", "nickname": "Depot - TM Hospital",
     "lat": 22.404423,  "lon": 113.968754,  "service_min": 20},
    {"name": "Tuen Mun Police Station", "nickname": "TM Police",
     "lat": 22.3866519, "lon": 113.968301,  "service_min": 15},
    {"name": "Point 3 (Tsuen Wan area)", "nickname": "TW Drop",
     "lat": 22.36892,   "lon": 114.1129885, "service_min": 15},
    {"name": "Tai Hing Estate", "nickname": "大興邨",
     "lat": 22.402933,  "lon": 113.9702707, "service_min": 15},
    {"name": "Butterfly Estate", "nickname": "蝴蝶邨",
     "lat": 22.3762852, "lon": 113.9620179, "service_min": 15},
    {"name": "Leung King Estate", "nickname": "良景邨",
     "lat": 22.4062251, "lon": 113.9619449, "service_min": 15},
    {"name": "Siu Hei Court", "nickname": "兆禧苑",
     "lat": 22.3738017, "lon": 113.9667096, "service_min": 15},
    {"name": "Melody Garden", "nickname": "美樂花園",
     "lat": 22.3743067, "lon": 113.9607311, "service_min": 15},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--no-optimize", action="store_true")
    ap.add_argument("--roundtrip", action="store_true")
    args = ap.parse_args()

    payload = {
        "stops": STOPS,
        "fuel": {"price": 19.50, "economy": 20.0, "unit": "l_per_100km"},
        "vehicle": {"key": "truck_5t", "label": "5-tonne truck"},
        "optimize": not args.no_optimize,
        "roundtrip": args.roundtrip,
    }
    url = f"http://127.0.0.1:{args.port}/api/route"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        plan = json.loads(resp.read().decode())

    if plan.get("error"):
        print("ERROR:", plan["error"]); return

    t = plan["totals"]; sh = plan["shift"]

    def hm(m):
        return f"{int(m // 60)}h {int(round(m - (m // 60) * 60)):02d}m"

    print("=" * 66)
    print("ROUTE PLAN —", plan["generated_at"],
          "|", plan.get("vehicle", {}).get("label", ""))
    print("=" * 66)
    print(f"Stops: {t['num_stops']}   Optimized: {plan['optimize']}   "
          f"Round trip: {plan['roundtrip']}")
    print(f"Total distance : {t['distance_km']:.2f} km")
    print(f"Driving time   : {hm(t['drive_min'])}")
    print(f"Service time   : {hm(t['service_min'])}")
    print(f"DELIVERY TIME  : {hm(t['delivery_min'])}  ({t['delivery_hours']:.2f} h)")
    limit = ("WITHIN 7h limit" if sh["within_limit"]
             else f"OVER 7h limit by {hm(sh['over_by_min'])}")
    print(f"7-HOUR CHECK   : {limit}")
    print(f"Total fuel     : {t['fuel_l']:.2f} L")
    print(f"TOTAL COST     : {t['cost']:.2f}")
    print("-" * 66)
    print("OPTIMIZED ORDER & PER-STOP BREAKDOWN:")
    print(f"{'#':>2}  {'Stop':26} {'LegKm':>7} {'Svc':>4} "
          f"{'LegCost':>8} {'CumTime':>9} {'CumCost':>8}")
    for b in plan["breakdown"]:
        print(f"{b['seq']:>2}  {b['name'][:26]:26} "
              f"{b['leg_distance_km']:>7.2f} {b['service_min']:>4.0f} "
              f"{b['leg_cost']:>8.2f} {hm(b['cum_time_min']):>9} "
              f"{b['cum_cost']:>8.2f}")
    print("-" * 66)
    print("SAVED FILES:")
    for k, v in plan.get("saved_files", {}).items():
        print(f"  {k:12} {v}")
    print("=" * 66)


if __name__ == "__main__":
    main()
