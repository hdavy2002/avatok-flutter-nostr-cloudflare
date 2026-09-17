/** Stable identifier for repository-authored headings; never use for user content. */
export function authoredKey(text:string) {
 let a=2166136261,b=2246822507;
 for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),3266489909);}
 return 'web-authored.'+(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
