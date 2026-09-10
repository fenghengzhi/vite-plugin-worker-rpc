import { compute } from './compute.rpc'
import './style.css'

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id)
  if (!result) throw new Error(`Missing playground element: ${id}`)
  return result as T
}

const button = element<HTMLButtonElement>('run')
const status = element('status')
const ticks = element('ticks')
const satellite = element('satellite')
const frames = element('frames')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
let frameCount = 0
let callStartedAtFrame: number | undefined

function tick(time: number): void {
  frameCount++
  ticks.textContent = String(frameCount).padStart(4, '0')
  if (!reducedMotion.matches) satellite.style.transform = `rotate(${time / 22}deg)`
  if (callStartedAtFrame !== undefined) {
    frames.textContent = `${frameCount - callStartedAtFrame} 次`
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

button.addEventListener('click', async () => {
  button.disabled = true
  button.textContent = '计算中…'
  status.textContent = 'Worker 正在求和，主线程仍在更新画面。'
  status.dataset.state = 'running'
  callStartedAtFrame = frameCount
  try {
    const result = await compute()
    element('location').textContent = result.inWorker ? 'Web Worker ✓' : '主线程'
    element('duration').textContent = `${Math.round(result.elapsedMs).toLocaleString()} ms`
    element('iterations').textContent = result.iterations.toLocaleString()
    element('sum').textContent = result.sum.toLocaleString()
    frames.textContent = `${frameCount - callStartedAtFrame} 次`
    status.textContent = `计算完成 · 期间主线程更新了 ${frameCount - callStartedAtFrame} 次画面`
    status.dataset.state = 'complete'
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
    status.dataset.state = 'error'
  } finally {
    callStartedAtFrame = undefined
    button.disabled = false
    button.innerHTML = '再次计算 <span aria-hidden="true">↗</span>'
  }
})
