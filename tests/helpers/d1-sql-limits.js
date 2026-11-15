// D1 제한 정적 검사(문장 하나 또는 ";"로 나눈 여러 문장).
// 왜: Cloudflare D1 은 SQLite 한도를 낮춰 둔다. node:sqlite·로컬 시험은 이 한도를 지키지 않아, 9항 UNION ALL 이 시험을 다 통과하고
// 운영에서 503("too many terms in compound SELECT")이 난 일이 있다. 문서 한도(https://developers.cloudflare.com/d1/platform/limits/):
//   compound SELECT 5항, SQL 함수 인자 32, 바인딩 100, 문장 100,000바이트, LIKE/GLOB 패턴 50바이트(글자 그대로의 패턴 또는 바인딩 값으로 만든 패턴).
// 문자열·따옴표 식별자·두 종류 주석을 왼쪽부터 한 번에 읽으므로, 주석 안 따옴표나 문자열 안 괄호·키워드·"?"는 세지 않는다.
// 여러 행 VALUES 는 compound 로 세지 않는다(로컬 D1 은 8행을 받는다). 표현식 깊이·결과 열 수는 실제 엔진 검사(scripts/check-d1.mjs)가 본다.
// 로컬 workerd D1 은 함수 인자 한도를 127로 두지만 여기서는 문서 값 32를 일부러 검사한다.
// 알려진 과다 계산(크게 실패하므로 바로 보인다): CTE 열 목록 "name(a,b,...)", 집계 함수 안 ORDER BY 의 쉼표, "INSERT INTO schema.table(...)".
// 쓰는 곳: scripts/check-d1.mjs(저장소 SQL 정적 검사), tests/helpers/fake-d1.js(시험에서 보내는 모든 문장), tests/worker-d1.test.mjs.
export const D1_LIMITS=Object.freeze({compoundTerms:5,functionArgs:32,boundParameters:100,statementBytes:100000,likePatternBytes:50});
const TOKEN=/\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$)|\[[^\]]*(?:\]|$)|\?\d*|[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?(?:e[+-]?\d+)?|\|\||[(),;]|[^\s]/giy;
// A word followed by "(" is a function call unless it is one of these keywords.
const NOT_CALL=new Set(['AS','IN','FROM','JOIN','ON','AND','OR','NOT','WHEN','THEN','ELSE','WHERE','SELECT','BY','CASE','VALUES','EXISTS','OVER','MATERIALIZED','USING','FILTER','WITH','RECURSIVE','CONFLICT','KEY','CHECK','UNIQUE','DEFAULT','IS','LIKE','GLOB','BETWEEN','ALL','DISTINCT','UNION','EXCEPT','INTERSECT','HAVING','GROUP','ORDER','LIMIT','OFFSET','SET','RETURNING','DO','WINDOW','PARTITION','RANGE','ROWS','INTO','TABLE','REFERENCES','INDEX']);
// ...or the word just before it means it is a table or index column list: INSERT INTO t(a,b), CREATE TABLE t(...), REFERENCES t(id).
// "ON t(a,b)" is a column list only inside CREATE [UNIQUE] INDEX; elsewhere "JOIN u ON coalesce(...)" is a call.
const COLUMN_LIST_AFTER=new Set(['INTO','TABLE','REFERENCES','EXISTS','VIEW','TRIGGER']);
// Words that end the pattern expression after LIKE/GLOB at the same parenthesis depth.
const LIKE_END=new Set(['AND','OR','ESCAPE','NOT','THEN','ELSE','END','WHEN','WHERE','GROUP','ORDER','LIMIT','UNION','EXCEPT','INTERSECT','HAVING','AS','FROM','IS','COLLATE']);
// Keywords after which LIKE/GLOB starts an expression (so "like(" there is the function), not after an operand.
const OPERATOR_CONTEXT=new Set(['SELECT','WHERE','AND','OR','ON','WHEN','THEN','ELSE','CASE','NOT','BY','HAVING','SET','RETURNING','VALUES','IN','IS','LIKE','GLOB','DISTINCT','ALL','AS','FROM','JOIN','USING','WITH','END']);
const bytes=text=>new TextEncoder().encode(text).length;
const unquote=literal=>literal.slice(1,literal.endsWith("'")&&literal.length>1?-1:undefined).replaceAll("''","'");
/** Static facts about one SQL text (one statement, or several separated by ";"). */
export function d1SqlInfo(sql){
 // statements: ";" ends a statement except inside a CREATE TRIGGER ... BEGIN ... END body (CASE ... END is told apart).
 const text=String(sql);let compound=1,functionArgs=0,auto=0,maxParameter=0,balanced=true,statements=0,content=false,first=null,createIndex=false,trigger=false,body=0,cases=0;
 const stack=[{terms:0,commas:0,call:false}],likeLiterals=[],likeParameters=[],likePatterns=[];let prev='',prev2='',like=null;
 const endLike=()=>{if(!like)return;if(like.params.length)likePatterns.push({literalBytes:like.literalBytes,params:like.params});else if(like.literal)likeLiterals.push(like.literalBytes);like=null;};
 TOKEN.lastIndex=0;
 for(let m;TOKEN.lastIndex<text.length&&(m=TOKEN.exec(text));){
  const t=m[0];if(!t)break;
  if(/^\s/.test(t)||t.startsWith('--')||t.startsWith('/*'))continue;
  const upper=/^[A-Za-z_]/.test(t)?t.toUpperCase():null;
  if(t!==';'){content=true;if(upper&&first===null)first=upper;if(first==='CREATE'&&upper==='INDEX'&&!trigger)createIndex=true;if(first==='CREATE'&&upper==='TRIGGER')trigger=true;
   if(trigger){if(upper==='BEGIN')body++;else if(upper==='CASE')cases++;else if(upper==='END'){if(cases)cases--;else if(body)body--;}}}
  // The pattern after LIKE/GLOB is read as operands joined by ||: a string, a parameter, a call name(...) or (...). Anything else at the
  // pattern's depth (an operator, a keyword, a column, ',' or ')') ends it, so values outside the pattern are never added.
  // like(pattern, value) written as a function is not followed. A column operand ends the pattern (its length is unknown statically).
  if(like){
   if(like.fresh&&t==='('&&like.functionForm)like=null;
   else if(stack.length===like.depth){
    if(like.pendingWord){like.pendingWord=false;if(t!=='(')endLike();}
    if(like){
     if(like.expect==='op'){if(t==='||')like.expect='operand';else endLike();}
     else if(t.startsWith("'")){like.literal=true;like.literalBytes+=bytes(unquote(t));like.expect='op';}
     else if(t.startsWith('?'))like.expect='op';
     else if(t!=='('){if(upper&&!LIKE_END.has(upper))like.pendingWord=true;else endLike();}
    }
   }
   if(like)like.fresh=false;
  }
  if(t.startsWith('?')){const n=t.length>1?Number(t.slice(1)):++auto;if(t.length>1)auto=Math.max(auto,n);maxParameter=Math.max(maxParameter,n);if(like){like.params.push(n);likeParameters.push(n);}}
  else if(t.startsWith("'")){if(like&&stack.length>like.depth){like.literal=true;like.literalBytes+=bytes(unquote(t));}}
  else if(t==='('){const word=/^[A-Za-z_]/.test(prev)?prev.toUpperCase():null,before=prev2.toUpperCase();stack.push({terms:0,commas:0,call:!!word&&!NOT_CALL.has(word)&&!COLUMN_LIST_AFTER.has(before)&&!(before==='ON'&&createIndex)});}
  else if(t===')'){if(stack.length===1){balanced=false;}else{const top=stack.pop();compound=Math.max(compound,top.terms+1);if(top.call)functionArgs=Math.max(functionArgs,top.commas+1);if(like&&stack.length===like.depth)like.expect='op';}}
  else if(t===','){stack.at(-1).commas++;}
  else if(t===';'){compound=Math.max(compound,stack[0].terms+1);stack[0].terms=0;if(!body){if(content)statements++;content=false;first=null;createIndex=false;trigger=false;cases=0;}}
  else if(upper==='UNION'||upper==='INTERSECT'||upper==='EXCEPT'){stack.at(-1).terms++;}
  else if(upper==='LIKE'||upper==='GLOB'){
   // Operator form "x [NOT] LIKE pattern" has an operand right before LIKE (or before NOT); otherwise "like(pattern, value)" is the function
   // form, which is not followed. "a LIKE (?)" is the operator form with a parenthesised pattern and is measured.
   const before=prev.toUpperCase()==='NOT'?prev2:prev,word=/^[A-Za-z_]/.test(before)?before.toUpperCase():null;
   const operand=before===')'||/^['"`[?\d]/.test(before)||(!!word&&!OPERATOR_CONTEXT.has(word));
   endLike();like={depth:stack.length,fresh:true,functionForm:!operand,expect:'operand',pendingWord:false,literal:false,literalBytes:0,params:[]};}
  prev2=prev;prev=t;
 }
 endLike();
 if(content)statements++;
 if(stack.length!==1)balanced=false;
 compound=Math.max(compound,stack[0].terms+1);
 return {compound,functionArgs,maxParameter,bytes:bytes(text),statements,likeLiterals,likeParameters,likePatterns,balanced};
}
/** Limit breaches visible in the SQL text alone. */
export function d1StatementViolations(info){
 const out=[];
 if(!info.balanced)out.push('unbalanced parentheses (the static check cannot read this statement)');
 if(info.compound>D1_LIMITS.compoundTerms)out.push(`compound SELECT has ${info.compound} terms (D1 max ${D1_LIMITS.compoundTerms})`);
 if(info.functionArgs>D1_LIMITS.functionArgs)out.push(`a SQL function call has ${info.functionArgs} arguments (D1 max ${D1_LIMITS.functionArgs})`);
 if(info.maxParameter>D1_LIMITS.boundParameters)out.push(`parameter number ${info.maxParameter} (D1 max ${D1_LIMITS.boundParameters})`);
 if(info.bytes>D1_LIMITS.statementBytes)out.push(`statement is ${info.bytes} bytes (D1 max ${D1_LIMITS.statementBytes})`);
 for(const n of info.likeLiterals)if(n>D1_LIMITS.likePatternBytes)out.push(`LIKE/GLOB literal pattern is ${n} bytes (D1 max ${D1_LIMITS.likePatternBytes})`);
 return out;
}
/** Limit breaches that depend on the bound values. A pattern built from bound strings (and literals joined with ||) is measured whole. */
export function d1BindViolations(info,args=[]){
 const out=[];
 if(args.length>D1_LIMITS.boundParameters)out.push(`${args.length} bound parameters (D1 max ${D1_LIMITS.boundParameters})`);
 for(const p of info.likePatterns||[]){
  const size=p.literalBytes+p.params.reduce((sum,n)=>sum+(typeof args[n-1]==='string'?bytes(args[n-1]):0),0);
  if(size>D1_LIMITS.likePatternBytes)out.push(`bound LIKE/GLOB pattern ${p.params.map(n=>'?'+n).join('||')} is ${size} bytes (D1 max ${D1_LIMITS.likePatternBytes})`);
 }
 return out;
}
