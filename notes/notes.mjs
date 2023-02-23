// import node 中包含当前文件的源数据 对象，当然你也可以扩展 它的meta 下的属性
// import.meta.url 用于返回当前文件的绝对路径 来源可以查看esm诞生就产生了import
// file:///Users/wushijiang/web/vite-plugin-vue-analysis/test/test.mjs
console.log(import.meta.url);


//路径解析
import {createRequire} from 'node:module';
let _require = createRequire(import.meta.url);
//try catch 是必要的因为，无法正确返回导致报错
try {
  console.log(_require.resolve('vue-sfc'));
}catch (err){}

function test(isCheck){
  console.log("执行了" + isCheck);
  return isCheck;
}

console.log(test(true) || test(true));
let name;
let nickName="tian";
console.log(`type=script.*&lang\.${
 name || nickName
}$`);
