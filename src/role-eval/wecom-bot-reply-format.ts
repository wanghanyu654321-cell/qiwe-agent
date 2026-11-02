/**
 * Product surface owns presentation: WeCom text does not render Markdown, so tables become short lines,
 * emphasis and headings are stripped, and internal runtime names never reach employees.
 */
export function sanitizeReply(text:string):string{
 if(typeof text!=='string')return '';
 const out:string[]=[];
 for(const line of text.replaceAll('\r\n','\n').split('\n')){
  if(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line))continue;
  if(/^\s*\|.*\|\s*$/.test(line)){
   const cells=line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim()).filter(Boolean);
   if(cells.length)out.push(cells.length>1?`${cells[0]}：${cells.slice(1).join('，')}`:cells[0]!);
   continue;
  }
  out.push(line.replace(/^\s{0,3}#{1,6}\s+/,'').replace(/\*\*(.+?)\*\*/g,'$1').replace(/__(.+?)__/g,'$1'));
 }
 const cleaned=out.join('\n').replace(/mini\s?claw/gi,'Front Claw').replace(/\n{3,}/g,'\n\n').trim();
 return cleaned||text.trim();
}
