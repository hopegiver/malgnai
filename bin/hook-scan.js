#!/usr/bin/env node

import { execSync } from 'child_process'

// stdin이 닫히지 않거나 느리게 오는 경우 SIGTERM(143)을 받는 것을 방지.
// 3초 타임아웃 후 강제 종료하되, 데이터가 충분히 오면 바로 처리.
let data = ''
let settled = false

function run() {
  if (settled) return
  settled = true
  try {
    if (!data.trim()) return
    const filePath = (JSON.parse(data).tool_input?.file_path || '').replace(/\\/g, '/')
    if (filePath.endsWith('.vue')) {
      execSync('node bin/scan.js app', { stdio: 'inherit' })
    } else if (filePath.includes('server/api/')) {
      execSync('node bin/scan.js server', { stdio: 'inherit' })
    }
  } catch { /* 파싱 실패 등은 무시 */ }
}

const timeout = setTimeout(() => run(), 3000)

process.stdin.on('data', (chunk) => { data += chunk })
process.stdin.on('end', () => {
  clearTimeout(timeout)
  run()
})
