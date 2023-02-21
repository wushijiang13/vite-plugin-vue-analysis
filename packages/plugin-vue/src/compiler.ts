// extend the descriptor so we can store the scopeId on it
//扩展描述符，以便在其上存储scopeId
declare module 'vue/compiler-sfc' {
  interface SFCDescriptor {
    id: string
  }
}

//导入 可以commonjs 的导入功能 支持导入文件
import { createRequire } from 'node:module'
//声明 'vue/compiler-sfc' 模块类型下编译器对象应该包含的参数
import type * as _compiler from 'vue/compiler-sfc'

//解析编译器，type 来自vue的模版解析模块
export function resolveCompiler(root: string): typeof _compiler {
  // resolve from project root first, then fallback to peer dep (if any)
  //首先从项目根解析，然后回退到对等dep（如果有）
  //这里是为了正确的找到vue/compiler-sfc模块的完整路径。
  const compiler =
    tryRequire('vue/compiler-sfc', root) || tryRequire('vue/compiler-sfc')
  //判断是否找到了，上面会进行短路执行，如果第一条满足就不会执行第二条，所以默认会执行携带整体路径root的
  //以为这段代码是内部调用，没有对root做非空判断而是选择 多次执行，并不赞同这种写法
  if (!compiler) {
    //如果没有成功，自然什么都没有，这里弹出没有 引入vue 报错即可
    throw new Error(
      `Failed to resolve vue/compiler-sfc.\n` +
        `@vitejs/plugin-vue requires vue (>=3.2.25) ` +
        `to be present in the dependency tree.`,
    )
  }
  //如果成功的话，代码会根据import.meta.url(当前模块)找到用户项目中sfc模块。并返回内部所有导出功能。
  //一般执行到这里就完全能得知是否能正确获取到渲染器
  return compiler
}

const _require = createRequire(import.meta.url)
//尝试导入文件,一个兜底，这里的有两个小细节
//1.通过createRequire 创建的用_require 声明 是因为它会和关键词 require 重名，产生执行冲突
//2.这里的try catch 是必须，因为_require去解析当前传入形参的完整路径可能会什么都没有，或者不能对参数进行保证
//所以这里会保证即使文件不存在依然可以正确执行。并且不需要对catch做任何处理
function tryRequire(id: string, from?: string) {
  try {
    return from
      ? _require(_require.resolve(id, { paths: [from] }))
      : _require(id)
  } catch (e) {}
}
