import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {dataDirectory,env} from '../server/config.js';

test('void0 environment values take precedence while previous names remain valid',()=>{
  assert.equal(env('DATABASE_URL',{VOID0_DATABASE_URL:'new',SERVERDESK_DATABASE_URL:'previous'}),'new');
  assert.equal(env('DATABASE_URL',{SERVERDESK_DATABASE_URL:'previous'}),'previous');
  assert.equal(env('DATABASE_URL',{}),undefined);
  assert.equal(env('PUBLIC_URL',{VOID0_PUBLIC_URL:'',SERVERDESK_PUBLIC_URL:'previous'}),'');
});

test('fresh installations use void0 data directories and explicit paths win',()=>{
  const directory=mkdtempSync(join(tmpdir(),'void0-config-'));
  try {
    assert.equal(dataDirectory('control',{},directory),join(directory,'.void0'));
    assert.equal(dataDirectory('publisher',{},directory),join(directory,'.void0-publisher'));
    assert.equal(dataDirectory('control',{VOID0_DATA_DIR:'chosen',SERVERDESK_DATA_DIR:'previous'},directory),join(directory,'chosen'));
    assert.equal(dataDirectory('control',{SERVERDESK_DATA_DIR:'previous'},directory),join(directory,'previous'));
    assert.equal(dataDirectory('publisher',{VOID0_PUBLISHER_DATA_DIR:'chosen'},directory),join(directory,'chosen'));
    assert.equal(dataDirectory('publisher',{SERVERDESK_PUBLISHER_DATA_DIR:'previous'},directory),join(directory,'previous'));
    assert.equal(dataDirectory('control',{VOID0_DATA_DIR:resolve(directory,'absolute')},directory),join(directory,'absolute'));
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('existing installations retain their original data without moving or rewriting files',()=>{
  const directory=mkdtempSync(join(tmpdir(),'void0-config-'));
  try {
    for(const kind of ['control','publisher'] as const){
      const suffix=kind==='publisher'?'-publisher':'';
      const previous=join(directory,`.serverdesk${suffix}`);
      mkdirSync(previous);
      writeFileSync(join(previous,'sentinel'),'existing-private-state');
      assert.equal(dataDirectory(kind,{},directory),previous);
      assert.equal(readFileSync(join(previous,'sentinel'),'utf8'),'existing-private-state');
      const current=join(directory,`.void0${suffix}`);
      mkdirSync(current);
      assert.equal(dataDirectory(kind,{},directory),current);
      assert.equal(readFileSync(join(previous,'sentinel'),'utf8'),'existing-private-state');
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});
