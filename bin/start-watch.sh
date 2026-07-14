#!/bin/bash
# watch-claude 데몬 시작 스크립트

cd /Users/hopegiver/workspace/malgnai

# nohup으로 데몬 시작 (기존 프로세스는 KeepAlive가 알아서 관리)
nohup /opt/homebrew/bin/node bin/watch-claude.js >> logs/watch-claude.log 2>&1 &

# 백그라운드에서 실행
sleep 1
