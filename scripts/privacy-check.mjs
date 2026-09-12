// Checks staged/tracked source without printing matching content.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if (!paths.length) {console.error('No tracked files: stage the release source before scanning.');process.exit(1);}
const failures=[];
for(const path of paths){
 if(/(^|\/)(\.env($|\.(?!example$))|secrets|node_modules|review|data|dist|.*\.sqlite(?:-.*)?$)/.test(path)) failures.push({path,rule:'private/generated path'});
 const text=fs.readFileSync(path,'utf8');
 const rules=[
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['cloud access key',/\bAKIA[A-Z0-9]{16}\b/],
 ['provider token',/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-proj-[A-Za-z0-9_-]{40,}|SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/],
 ['personal absolute path',/\/(?:Users|home)\/[a-zA-Z0-9._-]+\//],
 ['URL credentials',/https?:\/\/[^\s/'"`]+:[^\s/'"`]+@/]
 ];
 for(const [rule,regex] of rules)if(regex.test(text)&&!path.startsWith('tests/'))failures.push({path,rule});
}
if(failures.length){console.error(JSON.stringify({checked:paths.length,failures},null,2));process.exit(1);}
console.log(`Privacy pattern scan passed for ${paths.length} tracked files. Review diffs manually; no scanner guarantees absence of sensitive data.`);
