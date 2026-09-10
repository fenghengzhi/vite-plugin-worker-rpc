<template><p>Framework-generated RPC consumer</p></template>
<script>
import { calculate } from './compute.rpc?pool=1'

export function fromFramework(value) {
  return calculate(value, number => number + 1)
}
</script>
