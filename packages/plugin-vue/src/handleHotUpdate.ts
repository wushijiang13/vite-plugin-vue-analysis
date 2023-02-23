//一个debug 的库
import _debug from 'debug'
//导入sfc 的 block 和 描述 类型
import type { SFCBlock, SFCDescriptor } from 'vue/compiler-sfc'
//热更新上下文、 模块节点 类型
import type { HmrContext, ModuleNode } from 'vite'
// 是否是css 导入
import { isCSSRequest } from 'vite'

//创建描述符、获取描述符、设置父类描述符 来自描述符缓存文件
import {
  createDescriptor,
  getDescriptor,
  setPrevDescriptor,
} from './utils/descriptorCache'
//获取解析脚本、设置解析脚本
import { getResolvedScript, setResolvedScript } from './script'
//解析参数类型  来自index.js文件
import type { ResolvedOptions } from '.'

//使用debug打印vite各个模块热更新所耗费的时间
const debug = _debug('vite:hmr')
//直接请求 RE
const directRequestRE = /(?:\?|&)direct\b/

/**
 * Vite-specific HMR handling
 * 该插件重写了handleHotUpdate，对热更新加入判断处理
 * 执行自定义 HMR 更新处理
 */
export async function handleHotUpdate(
  { file, modules, read, server }: HmrContext,//热更新上下文
  options: ResolvedOptions,//解析参数
): Promise<ModuleNode[] | void> { //返回一个promise的返回 是 模块节点或者空
  //获取父节点 或者说是上一个节点
  const prevDescriptor = getDescriptor(file, options, false)
  //如果父节点是空 直接退出这次热更新处理
  if (!prevDescriptor) {
    // file hasn't been requested yet (e.g. async component)
    //尚未请求文件（例如异步组件）
    return
  }
  // 当父节点不等于空时将，之前获取的父节点赋值
  setPrevDescriptor(file, prevDescriptor)

  // 这是一个异步读函数，它返回文件的内容。
  // 之所以这样做，是因为在某些系统上，文件更改的回调函数可能会在编辑器完成文件更新之前过快地触发，
  // 并 fs.readFile 直接会返回空内容。传入的 read 函数规范了这种行为。
  const content = await read() //会返回当前模块的 文件内容

  //根据内容创建当前节点信息，并解构出修饰符
  const { descriptor } = createDescriptor(file, content, options)
  //是否需要重新发送
  let needRerender = false
  //接受一组受影响模块 当ModuleNode没有会是undefined
  const affectedModules = new Set<ModuleNode | undefined>()
  //modules是受更改文件影响的模块数组。它是一个数组，因为单个文件可能映射到多个服务模块
  //主模块是 "收到更改文件影响的模块数组" 过滤掉script和type 这段代码是为了找到入口模块
  const mainModule = modules
    .filter((m) => !/type=/.test(m.url) || /type=script/.test(m.url))
    // #9341
    // We pick the module with the shortest URL in order to pick the module
    // with the lowest number of query parameters.
    //我们选择具有最短URL的模块，以便选择模块
    // 查询参数的数量最少。
    .sort((m1, m2) => {
      return m1.url.length - m2.url.length
    })[0]
  //模版模块 查找到第一个为template的模块信息
  const templateModule = modules.find((m) => /type=template/.test(m.url))
  //脚本已更改的
  const scriptChanged = hasScriptChanged(prevDescriptor, descriptor)
  if (scriptChanged) {
    let scriptModule: ModuleNode | undefined
    //如果描述属性中 有lang 设置ts 等类型 并且没有src 或者 script 有lang 并且没有 src 为正确格式
    if (
      (descriptor.scriptSetup?.lang && !descriptor.scriptSetup.src) ||
      (descriptor.script?.lang && !descriptor.script.src)
    ) {
      //脚本模块的正则表达式生成
      const scriptModuleRE = new RegExp(
        `type=script.*&lang\.${
          descriptor.scriptSetup?.lang || descriptor.script?.lang
        }$`,
      )
      //根据上面生成的正则查找到首个符合的脚本模块
      scriptModule = modules.find((m) => scriptModuleRE.test(m.url))
    }
    //影响模块 如果没有当前模块就加入入口模块
    affectedModules.add(scriptModule || mainModule)
  }
  //当前组件的templte 和 父组件template 是否不一致
  if (!isEqualBlock(descriptor.template, prevDescriptor.template)) {
    // when a <script setup> component's template changes, it will need correct
    // binding metadata. However, when reloading the template alone the binding
    // metadata will not be available since the script part isn't loaded.
    // in this case, reuse the compiled script from previous descriptor.
    //当＜script setup＞组件的模板更改时，它需要正确
    //绑定元数据。但是，当单独重新加载模板时，绑定
    //由于未加载脚本部分，元数据将不可用。
    //在这种情况下，重用先前描述符中编译的脚本。
    //脚本是否没有更改过
    if (!scriptChanged) {
      //设置解析脚本 传入当前属性和父属性，都不是ssr模式
      setResolvedScript(
        descriptor,
        getResolvedScript(prevDescriptor, false)!,
        false,
      )
    }
    //将模块信息 加入受影响模块集合中
    affectedModules.add(templateModule)
    //需要重新渲染
    needRerender = true
  }
  //样式是否发生 改变
  let didUpdateStyle = false
  //老样式
  const prevStyles = prevDescriptor.styles || []
  //新样式
  const nextStyles = descriptor.styles || []
  // force reload if CSS vars injection changed
  // 如果CSS变量注入更改，则强制重新加载
  if (prevDescriptor.cssVars.join('') !== descriptor.cssVars.join('')) {
    //加入到受影响模块中
    affectedModules.add(mainModule)
  }

  // force reload if scoped status has changed
  // 如果样式作用域状态已更改，则强制重新加载
  if (prevStyles.some((s) => s.scoped) !== nextStyles.some((s) => s.scoped)) {
    // template needs to be invalidated as well
    // 模板也需要作废
    affectedModules.add(templateModule)
    //加入到受影响模块中
    affectedModules.add(mainModule)
  }

  // only need to update styles if not reloading, since reload forces
  // style updates as well.
  // 如果不重新加载，只需要更新样式，因为重新加载强制
  // 样式更新。
  for (let i = 0; i < nextStyles.length; i++) {
    const prev = prevStyles[i]
    const next = nextStyles[i]
    //逐一对比样式 只要不一致 将需要更新样式设置为true
    if (!prev || !isEqualBlock(prev, next)) {
      didUpdateStyle = true
      //找到需要首个更新的样式部分
      const mod = modules.find(
        (m) =>
          m.url.includes(`type=style&index=${i}`) &&
          m.url.endsWith(`.${next.lang || 'css'}`) &&
          !directRequestRE.test(m.url),
      )
      //如果有需要更新的样式模块
      if (mod) {
        affectedModules.add(mod)
        //样式里有涉及到 inline 就更入口模版
        if (mod.url.includes('&inline')) {
          affectedModules.add(mainModule)
        }
      } else {
        // new style block - force reload
        //新样式块-强制重新加载
        affectedModules.add(mainModule)
      }
    }
  }
  if (prevStyles.length > nextStyles.length) {
    // style block removed - force reload
    //样式块已删除-强制重新加载
    affectedModules.add(mainModule)
  }
  //老自定义
  const prevCustoms = prevDescriptor.customBlocks || []
  //新自定义
  const nextCustoms = descriptor.customBlocks || []

  // custom blocks update causes a reload
  // because the custom block contents is changed and it may be used in JS.
  //自定义块更新导致重新加载
  //因为自定义块内容被更改，并且可以在JS中使用。
  if (prevCustoms.length !== nextCustoms.length) {
    // block removed/added, force reload
    // 移除/添加块，强制重新加载
    affectedModules.add(mainModule)
  } else {
    //循环对比新老自定义块 找到的第一个加入受影响模块，如果没有找到，就强制重新加载
    for (let i = 0; i < nextCustoms.length; i++) {
      const prev = prevCustoms[i]
      const next = nextCustoms[i]
      if (!prev || !isEqualBlock(prev, next)) {
        const mod = modules.find((m) =>
          m.url.includes(`type=${prev.type}&index=${i}`),
        )
        if (mod) {
          affectedModules.add(mod)
        } else {
          affectedModules.add(mainModule)
        }
      }
    }
  }
  //更改类型集合
  const updateType = []
  //是否需要重新渲染
  if (needRerender) {
    updateType.push(`template`)
    // template is inlined into main, add main module instead
    //模板内联到main中，改为添加main模块
    //如果模版模块不一致就 重新强制渲染
    if (!templateModule) {
      affectedModules.add(mainModule)
    //入口模块 有且 受影响模块中没有入口模块
    } else if (mainModule && !affectedModules.has(mainModule)) {
      //样式导入器 过滤掉css 导入
      const styleImporters = [...mainModule.importers].filter((m) =>
        isCSSRequest(m.url),
      )
      // 过滤完成后，全部添加到受影响模块
      styleImporters.forEach((m) => affectedModules.add(m))
    }
  }
  //样式是否发生改变
  if (didUpdateStyle) {
    updateType.push(`style`)
  }
  //更改类型合集有值的话 debug 输出此次文件更新的所有类型
  if (updateType.length) {
    debug(`[vue:update(${updateType.join('&')})] ${file}`)
  }
  //最后导出 所有受影响模块
  return [...affectedModules].filter(Boolean) as ModuleNode[]
}

/***
 * 是否是相同的块
 * @param a
 * @param b
 */
export function isEqualBlock(a: SFCBlock | null, b: SFCBlock | null): boolean {
  if (!a && !b) return true //如果两个都是空 返回相同
  if (!a || !b) return false // 如果有其中有一个是空就返回不同
  // src imports will trigger their own updates
  //src导入将触发它们自己的更新
  //如果两个都拥有src 并且相同 返回相同
  if (a.src && b.src && a.src === b.src) return true
  //如果两个内容如果不相同 就返回不相同
  if (a.content !== b.content) return false
  // 获取a 下所有属性下所有的key
  const keysA = Object.keys(a.attrs)
  // 获取b 下所有属性下所有的key
  const keysB = Object.keys(b.attrs)
  //如果两个长度不同 返回不同
  if (keysA.length !== keysB.length) {
    return false
  }
  //逐一对比属性值 看是否相同
  return keysA.every((key) => a.attrs[key] === b.attrs[key])
}

//仅限模板已更改
export function isOnlyTemplateChanged(
  prev: SFCDescriptor,
  next: SFCDescriptor,
): boolean {
  //属性 && 样式 && 自定义块 全部相同
  return (
    !hasScriptChanged(prev, next) &&
    prev.styles.length === next.styles.length &&
    prev.styles.every((s, i) => isEqualBlock(s, next.styles[i])) &&
    prev.customBlocks.length === next.customBlocks.length &&
    prev.customBlocks.every((s, i) => isEqualBlock(s, next.customBlocks[i]))
  )
}

//
/***
 * 判断目标两个script是否相同，如果不相同就返回已经更改过，script 指代 vue2
 * scriptSetup 指代vue3 或者一个指代一个 选项式写法和组合式写法
 * @param prev
 * @param next
 */
function hasScriptChanged(prev: SFCDescriptor, next: SFCDescriptor): boolean {
  //判断选项式
  if (!isEqualBlock(prev.script, next.script)) {
    return true
  }
  //判断组合式
  if (!isEqualBlock(prev.scriptSetup, next.scriptSetup)) {
    return true
  }

  // vue core #3176
  // <script setup lang="ts"> prunes non-unused imports
  // the imports pruning depends on template, so script may need to re-compile
  // based on template changes
  //<script setup lang=“ts”>删除未使用的导入
  //导入修剪依赖于模板，因此脚本可能需要重新编译
  //基于模板更改
  const prevResolvedScript = getResolvedScript(prev, false)
  // this is only available in vue@^3.2.23
  // 这只在vue@^3.2.23中可用
  // 判断导入 导入映射表 (Import Maps)
  const prevImports = prevResolvedScript?.imports
  if (prevImports) {
    return !next.template || next.shouldForceReload(prevImports)
  }

  return false
}

/**
 * 问题：
 * 1.prevDescriptor和descriptor 指代的是什么？
 * 2.mainModule 是入口模块，还是强制刷新的口子？
 * 3.affectedModules 受影响最后去哪个模块执行渲染
 * */
