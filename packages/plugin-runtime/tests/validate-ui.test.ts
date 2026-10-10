import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBrowserModule } from '../src/validate-ui'

test('浏览器 ESM 允许已打包依赖的局部 CommonJS 包装，拒绝 Node 导入和全局 require', () => {
  assert.doesNotThrow(() =>
    validateBrowserModule(
      `const wrapped = (function(module) { module.exports = {}; return module.exports })({}); export function activate() { return wrapped }`,
    ),
  )
  assert.throws(
    () => validateBrowserModule(`import fs from 'node:fs'; export function activate() { return fs }`),
    /Node/,
  )
  assert.throws(() => validateBrowserModule(`export function activate() { return require('react') }`), /require/)
  assert.throws(() => validateBrowserModule(`module.exports = function() {}`), /ESM/)
  assert.throws(() => validateBrowserModule(`export const activate = module.exports`), /CommonJS/)
  assert.throws(() => validateBrowserModule(`import { shell } from 'electron'; export const activate = shell`), /Node/)
})
