import { createHash } from 'node:crypto';
export const contentNamespace = filename => 'web-content-' + createHash('sha256').update(filename.replaceAll('\\','/').split('/src/content/').pop()).digest('hex').slice(0,12);
export const contentKey = (namespace,text) => namespace+'.'+createHash('sha256').update(text).digest('hex').slice(0,16);
/** Only repository-authored content is eligible. Never runs on API/user content. */
export default function remarkUiCopy() {
 return (tree,file)=>{
  const filename=String(file.path||'');if(!filename.replaceAll('\\','/').includes('/src/content/'))return;
  const namespace=contentNamespace(filename);
  const walk=node=>{if(['code','inlineCode','html','yaml','toml'].includes(node.type))return;if(!node.children)return;
   node.children=node.children.map(child=>{
    if(child.type==='text'&&child.value.trim()&&/[\p{L}]/u.test(child.value))return {type:'emphasis',data:{hName:'ui-copy',hProperties:{style:'display:contents','data-i18n':contentKey(namespace,child.value)}},children:[child]};
    walk(child);return child;
   });
  };walk(tree);
 };
}
