import { defineConfig } from 'vite'
import workerRpc from '../src/index.ts'

export default defineConfig({
  plugins: [workerRpc()],
})
