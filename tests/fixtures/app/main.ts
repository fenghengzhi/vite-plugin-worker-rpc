import {
  add,
  counter,
  delayed,
  echo,
  fail,
  inspectRuntime,
  sourceVersion,
  renamed,
} from './compute.rpc?pool=1'
import { subtract } from './plain.rpc.js'

Object.assign(window, {
  rpcTest: {
    add,
    counter,
    delayed,
    echo,
    fail,
    inspectRuntime,
    sourceVersion,
    renamed,
    subtract,
  },
  rpcBootId: crypto.randomUUID(),
})
