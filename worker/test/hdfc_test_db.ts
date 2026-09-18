// Real SQLite execution with D1-style numbered binds and all-or-nothing batch.
// CI only (Node 22 --experimental-sqlite). No canned SQL result mocks.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Env } from '../src/types';
interface Statement {run(...args:unknown[]):{changes:number};get(...args:unknown[]):Record<string,unknown>|undefined;all(...args:unknown[]):Record<string,unknown>[]}
export interface Sqlite {exec(sql:string):void;prepare(sql:string):Statement;close():void}
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:new(path:string)=>Sqlite};
export const baseSql=readFileSync(new URL('../migrations/2026-09-17-hdfc-sms-payments.sql',import.meta.url),'utf8');
export const smokeSql=readFileSync(new URL('../migrations/2026-09-18-hdfc-sms-smoke-v2.sql',import.meta.url),'utf8');
export const customerSql=readFileSync(new URL('../migrations/2026-09-18-hdfc-customer-test.sql',import.meta.url),'utf8');
export const publicVpaSql=readFileSync(new URL('../migrations/2026-09-18-hdfc-sms-public-vpa.sql',import.meta.url),'utf8');
export function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON;');sql.exec(baseSql);sql.exec(smokeSql);sql.exec(customerSql);sql.exec(publicVpaSql);
 const account=createHash('sha256').update('HDFC|1234|INR').digest('hex');
 sql.exec(`CREATE VIEW hdfc_sms_smoke_ready AS SELECT 2 protocol_version,0 cutover_ms,'${"a".repeat(64)}' seed_digest,'${account}' receiving_account_key;`);
 sql.exec(`CREATE TABLE admin_roles(uid TEXT PRIMARY KEY,role TEXT);
 CREATE TABLE wallet_ledger(id TEXT PRIMARY KEY,ref TEXT,type TEXT,amount INTEGER);
 CREATE TABLE commercial_checkout_operations(operation_id TEXT PRIMARY KEY,order_id TEXT,account_id TEXT,listing_id TEXT,state TEXT);
 CREATE TABLE commercial_policy_snapshots(order_id TEXT,buyer_id TEXT,gross_amount INTEGER,currency TEXT);`);
 sql.prepare("INSERT INTO admin_roles VALUES (?,?)").run('admin','finance');
 const prepare=(source:string)=>{
  let next=1;const used=new Set<number>();
  const query=source.replace(/\?(\d*)/g,(_,digits:string)=>{const n=digits?Number(digits):next;next=Math.max(next,n+1);used.add(n);return `$p${n}`;});
  let params:Record<string,unknown>={};
  const runSync=()=>{const result=sql.prepare(query).run(params);return {success:true,results:[],meta:{changes:Number(result.changes)}};};
  const result={
   bind(...values:unknown[]){params={};for(const n of used)params[`p${n}`]=values[n-1]??null;return result;},
   runSync,async run(){return runSync();},
   async first<T>(){return sql.prepare(query).get(params) as T|undefined??null;},
   async all<T>(){return {success:true,results:sql.prepare(query).all(params) as T[],meta:{changes:0}};},
  };return result;
 };
 const d1={prepare,async batch(statements:ReturnType<typeof prepare>[]){sql.exec('BEGIN');try{const results=statements.map(s=>s.runSync());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}} as unknown as D1Database;
 const kv=new Map<string,string>();
 const env={TOKENS:{get:async(key:string)=>kv.get(key)??null,put:async(key:string,value:string)=>{kv.set(key,value);}},DB_META:d1,DB_WALLET:d1,ADMIN_UIDS:'admin,other,readonly',HDFC_UPI_VPA:'smoke@bank',HDFC_UPI_PAYEE_NAME:'Internal',HDFC_SMS_ACCOUNT_SUFFIX:'1234',HDFC_SMS_DEVICE_ID:'test-device',HDFC_SMS_DEVICE_SECRET:'synthetic-test-secret-only'} as Env;
 return {sql,db:d1,env};
}
export function request(path:string,body?:unknown,uid='admin'){
 return new Request(`https://test.invalid${path}`,{method:body===undefined?'GET':'POST',headers:{'x-test-uid':uid,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
