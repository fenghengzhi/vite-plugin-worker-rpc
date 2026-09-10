import { inspect } from './custom.worker-rpc'
import { localValue } from './excluded.worker-rpc'

Object.assign(window, { customRpcTest: { inspect, localValue } })
