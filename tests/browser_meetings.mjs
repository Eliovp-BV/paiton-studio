import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.STUDIO_TEST_URL||'http://127.0.0.1:8897';assert.notEqual(new URL(base).port,'8877');
const browser=await chromium.launch({headless:true,executablePath:process.env.STUDIO_CHROMIUM});
const page=await browser.newPage({viewport:{width:1600,height:1000}});const errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/'))errors.push(r.status()+' '+r.url());});
try {
 await page.goto(base+'/#home');await page.locator('.new-project-tile').click();
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Meetings',exact:true}).click();
 await page.getByRole('heading',{name:'Transcribe your meeting',exact:true}).waitFor();
 // A one-second silence fixture checks import and persistence only, never inference.
 const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
 await page.getByLabel('Import meeting recording').setInputFiles({name:'Browser import fixture.wav',mimeType:'audio/wav',buffer:wav});
 await page.getByText('Recording imported. Ready for local processing.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Transcribe and summarize locally',exact:true}).waitFor();
 assert.equal(await page.locator('.meeting-result audio').count(),1);
 await page.reload();
 await page.locator('.meeting-list').getByRole('button',{name:/Browser import fixture/}).click();
 await page.getByText('Recording imported. Ready for local processing.',{exact:true}).waitFor();
 await page.screenshot({path:'.local/meetings-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:'.local/meetings-mobile.png',fullPage:true});
 await page.getByText('Recording storage & deletion',{exact:true}).click();
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Delete recording and derived content',exact:true}).click();
 await page.getByText('Your imported recordings will appear here.',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('Meetings browser passed: navigation, real audio decoding/upload, project persistence, playback, deletion and responsive layout; no inference submitted.');
}finally{await browser.close();}
