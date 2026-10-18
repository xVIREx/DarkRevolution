#!/bin/sh
# usage: tools/scene_shot.sh "<query>" out.png   (needs: python3 -m http.server 8765 from repo root)
google-chrome --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=1280,720 \
  --virtual-time-budget=20000 --hide-scrollbars --screenshot="$2" "http://127.0.0.1:8765/tools/scene_preview.html?$1&w=1280&h=720" 2>/dev/null
