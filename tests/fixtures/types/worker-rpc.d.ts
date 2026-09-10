// A global declaration file: do not add a top-level import or export.
// Each suffix must identify one source module throughout the TypeScript project.
declare module '*compute.rpc?pool=1' {
  type API = import('../../../src/index.js').Remote<typeof import('./compute.rpc')>
  export const add: API['add']
  export const greet: API['greet']
}

declare module '*compute.rpc?pool=4' {
  type API = import('../../../src/index.js').Remote<typeof import('./compute.rpc')>
  export const add: API['add']
  export const greet: API['greet']
}

declare module '*compute.rpc?pool=auto' {
  type API = import('../../../src/index.js').Remote<typeof import('./compute.rpc')>
  export const add: API['add']
  export const greet: API['greet']
}

declare module '*compute.rpc?pool=unlimited' {
  type API = import('../../../src/index.js').Remote<typeof import('./compute.rpc')>
  export const add: API['add']
  export const greet: API['greet']
}
