import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { InjectOptions } from 'fastify';
import { createApp } from '../server/app.js';

const ownPassword='chosen-by-the-owner-2026';
const otherPassword='attempt-to-add-second-admin';

async function freshInstallation() {
  const directory=mkdtempSync(join(tmpdir(),'serverdesk-auth-'));
  const created=await createApp({dataDir:directory,startWorker:false,webRoot:join(directory,'absent-web')});
  const setupToken=readFileSync(join(directory,'setup-token'),'utf8').trim();
  const request=(method:InjectOptions['method'],url:string,payload?:InjectOptions['payload'],headers:Record<string,string>={})=>created.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{host:'localhost:4317',...headers}});
  return {...created,directory,setupToken,request,close:async()=>{await created.app.close();rmSync(directory,{recursive:true,force:true});}};
}

test('a fresh installation has no preconfigured password and accepts only owner initialization',async()=>{
  const fixture=await freshInstallation();
  try {
    const session=await fixture.request('GET','/api/session');
    assert.deepEqual(session.json(),{authenticated:false,setupRequired:true,setupTokenRequired:true});
    assert.equal((await fixture.store.vault.has('admin')),false);
    assert.ok(fixture.setupToken.length>=24);
    assert.equal(statSync(join(fixture.directory,'setup-token')).mode&0o777,0o600);
    assert.equal((await fixture.request('GET','/api/workspace')).statusCode,401);
    const wrongCode=await fixture.request('POST','/api/setup',{setupToken:'wrong-installation',password:ownPassword});
    assert.equal(wrongCode.statusCode,403);
    assert.equal((await fixture.store.vault.has('admin')),false);
    const shortPassword=await fixture.request('POST','/api/setup',{setupToken:fixture.setupToken,password:'short'});
    assert.equal(shortPassword.statusCode,400);
    assert.equal((await fixture.store.vault.has('admin')),false);
    const created=await fixture.request('POST','/api/setup',{setupToken:fixture.setupToken,password:ownPassword});
    assert.equal(created.statusCode,200,created.body);
    assert.deepEqual(Object.keys(created.json()).sort(),['authenticated','csrfToken','setupRequired','setupTokenRequired']);
    assert.equal(created.json().setupRequired,false);
    assert.equal(created.json().setupTokenRequired,false);
    assert.match(String(created.headers['set-cookie']),/HttpOnly/);
    const stored=(await fixture.store.vault.get<{salt:string;hash:string}>('admin'));
    assert.ok(stored);
    assert.equal(stored.salt.length,32);
    assert.equal(stored.hash.length,128);
    assert.equal(JSON.stringify(stored).includes(ownPassword),false);
    assert.equal(created.body.includes(ownPassword),false);
    const cookie=String(created.headers['set-cookie']).split(';')[0];
    assert.equal((await fixture.request('GET','/api/workspace',undefined,{cookie})).statusCode,200);
  }finally{await fixture.close();}
});

test('concurrent initialization creates exactly one administrator and cannot add or replace one',async()=>{
  const fixture=await freshInstallation();
  try {
    const passwords=[ownPassword,otherPassword];
    const responses=await Promise.all(passwords.map(password=>fixture.request('POST','/api/setup',{setupToken:fixture.setupToken,password})));
    assert.deepEqual(responses.map(response=>response.statusCode).sort(),[200,409]);
    const winner=responses.findIndex(response=>response.statusCode===200);
    const loser=winner===0?1:0;
    const stored=(await fixture.store.vault.get<{salt:string;hash:string}>('admin'));
    assert.equal((await fixture.request('POST','/api/login',{password:passwords[loser]})).statusCode,401);
    const login=await fixture.request('POST','/api/login',{password:passwords[winner]});
    assert.equal(login.statusCode,200,login.body);
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const csrf=login.json().csrfToken;
    for(const endpoint of ['/api/users','/api/register','/api/signup']) {
      const response=await fixture.request('POST',endpoint,{username:'second-owner',password:otherPassword},{cookie,'x-csrf-token':csrf});
      assert.equal(response.statusCode,404,`${endpoint} must not create another account`);
    }
    const secondSetup=await fixture.request('POST','/api/setup',{setupToken:fixture.setupToken,password:otherPassword},{cookie});
    assert.equal(secondSetup.statusCode,409);
    assert.deepEqual((await fixture.store.vault.get('admin')),stored);
  }finally{await fixture.close();}
});

test('restart retains the same single administrator and logout invalidates its session',async()=>{
  const fixture=await freshInstallation();
  let originalClosed=false;
  try {
    const first=await fixture.request('POST','/api/setup',{setupToken:fixture.setupToken,password:ownPassword});
    assert.equal(first.statusCode,200,first.body);
    const originalAdmin=(await fixture.store.vault.get('admin'));
    await fixture.app.close();originalClosed=true;
    const reopened=await createApp({dataDir:fixture.directory,startWorker:false,webRoot:join(fixture.directory,'absent-web')});
    try {
      const request=(method:InjectOptions['method'],url:string,payload?:InjectOptions['payload'],headers:Record<string,string>={})=>reopened.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{host:'localhost:4317',...headers}});
      assert.equal(readFileSync(join(fixture.directory,'setup-token'),'utf8').trim(),fixture.setupToken);
      assert.deepEqual((await reopened.store.vault.get('admin')),originalAdmin);
      assert.deepEqual((await request('GET','/api/session')).json(),{authenticated:false,setupRequired:false,setupTokenRequired:false});
      assert.equal((await request('POST','/api/setup',{setupToken:fixture.setupToken,password:otherPassword})).statusCode,409);
      const wrong=await request('POST','/api/login',{password:otherPassword});
      assert.equal(wrong.statusCode,401);
      assert.match(wrong.json().error,/密码/);
      const login=await request('POST','/api/login',{password:ownPassword});
      assert.equal(login.statusCode,200,login.body);
      const cookie=String(login.headers['set-cookie']).split(';')[0];
      const csrf=login.json().csrfToken;
      assert.equal((await request('GET','/api/workspace',undefined,{cookie})).statusCode,200);
      assert.equal((await request('POST','/api/logout',{}, {cookie,'x-csrf-token':csrf})).statusCode,200);
      assert.equal((await request('GET','/api/workspace',undefined,{cookie})).statusCode,401);
      assert.deepEqual((await reopened.store.vault.get('admin')),originalAdmin);
    }finally{await reopened.app.close();}
  }finally{
    if(!originalClosed)await fixture.app.close();
    rmSync(fixture.directory,{recursive:true,force:true});
  }
});
