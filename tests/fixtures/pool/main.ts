import { hold as defaultHold } from './work.rpc'
import { hold as oneHold } from './work.rpc?pool=1'
import { hold as aliasOneHold } from '@pool-worker?pool=1'
import { hold as twoHold, run as twoRun } from './work.rpc?pool=2'
import { hold as unlimitedHold } from './work.rpc?pool=unlimited'
import { hold as autoHold } from './work.rpc?pool=auto'
import { hold as aliasAutoHold } from '@pool-worker?pool=auto'
import { holdA } from './consumer-a'
import { holdB } from './consumer-b'

Object.assign(window, {
  poolApi: { defaultHold, oneHold, aliasOneHold, twoHold, twoRun, unlimitedHold, autoHold, aliasAutoHold, holdA, holdB },
  poolBootId: crypto.randomUUID(),
})
