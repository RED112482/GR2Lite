import {test,expect, type Page} from '@playwright/test';

const baseTime='2026-11-15T18:00:00.000Z';
const moments=(gates:number)=>Object.fromEntries(['REF','VEL'].map((m)=>[m,{
  name:m,source_variable:m==='REF'?'DBZH':'VRADH',units:m==='REF'?'dBZ':'m/s',
  rays:90,gates,first_gate_m:250,gate_spacing_m:250,encoding:'float32-le',missing:'NaN'
}]));
const sweeps=[0.5,1.5].map((angle,i)=>({
  id:'sweep_'+i,index:i,fixed_angle_deg:angle,ray_count:90,
  azimuth_deg:Array.from({length:90},(_,a)=>a*4),
  elevation_deg:Array(90).fill(angle),
  time_utc:Array.from({length:90},(_,a)=>new Date(Date.parse(baseTime)+i*60000+a*300).toISOString()),
  moments:moments(100)
}));
const descriptor={
  contract_version:'0.1.0',volume_id:'KMOB_TEST_VOLUME',
  radar_id:'KMOB',radar_lat:30.68,radar_lon:-88.24,radar_alt_m:70,
  source:'archive',vcp:'35',dynamic_scan_type:'standard',avset_enabled:false,volume_complete:true,sweeps
};
async function mockRadar(page:Page,withHistory=false) {
  await page.route('**/api/**',async route=>{
    const pathname=new URL(route.request().url()).pathname.replace(/^\/api/,'');
    const json=(body:unknown)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(pathname==='/radar/status')return json({
      mode:'archive',state:'ready',latest_volume_id:descriptor.volume_id,
      age_seconds:18,last_error:null,last_check_utc:null,latency_metrics:{discovery_ms:12.5,download_ms:83.2,decode_ms:210.4,publish_ms:3.1}
    });
    if(pathname==='/volumes/index')return json([
      {volume_id:descriptor.volume_id,radar_id:'KMOB',time_utc:baseTime,sweeps:2},
      ...(withHistory?[{volume_id:'KMOB_TEST_VOLUME_OLDER',radar_id:'KMOB',
        time_utc:'2026-11-15T17:55:00.000Z',sweeps:2}]:[])
    ]);
    if(pathname==='/volumes/KMOB_TEST_VOLUME')return json(descriptor);
    if(pathname==='/volumes/KMOB_TEST_VOLUME_OLDER')
      return json({...descriptor,volume_id:'KMOB_TEST_VOLUME_OLDER'});
    if(pathname.startsWith('/boundaries/'))return json({type:'FeatureCollection',features:[]});
    if(pathname.endsWith('/moments/REF')||pathname.endsWith('/moments/VEL')){
      const vel=pathname.endsWith('/VEL');
      const values=new Float32Array(90*100).fill(vel?12:25);
      if(vel)values.fill(-64.5,0,200); // valid ND test sentinel
      return route.fulfill({
        status:200,contentType:'application/octet-stream',
        body:Buffer.from(values.buffer)
      });
    }
    return route.fulfill({status:404,body:'Not found'});
  });
}

test('multi-panel controls configure only the selected radar pane',async({page})=>{
  await mockRadar(page);
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('ARCHIVE READY',{timeout:20000});
  await page.locator('#headerLayouts button[data-panels="2"]').click();
  await expect(page.locator('#panelGrid .panel-tile')).toHaveCount(2);
  await expect(page.locator('#panelGrid')).toBeVisible();
  await expect(page.locator('#panelGrid .panel-caption').first()).toContainText('REF');
  await expect(page.locator('#panelGrid .panel-caption').nth(1)).toContainText('VEL');
  await page.locator('#panelGrid .panel-tile').nth(1).click();
  await expect(page.locator('#panelSelection')).toContainText('Editing panel 2 of 2');
  await page.locator('#moments button').getByText('REF',{exact:true}).click();
  await expect(page.locator('#panelGrid .panel-caption').nth(0)).toContainText('REF');
  await expect(page.locator('#panelGrid .panel-caption').nth(1)).toContainText('REF');
  await page.locator('#tilt').selectOption('sweep_1');
  await expect(page.locator('#panelGrid .panel-caption').first()).toContainText('0.5');
  await expect(page.locator('#panelGrid .panel-caption').nth(1)).toContainText('1.5');
});

test('four and sixteen pane layouts have visible independent tiles',async({page})=>{
  await mockRadar(page);
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('ARCHIVE READY',{timeout:20000});
  await page.locator('#headerLayouts button[data-panels="4"]').click();
  await expect(page.locator('#panelGrid .panel-tile')).toHaveCount(4);
  await page.locator('#panelGrid .panel-tile').nth(2).click();
  await expect(page.locator('#panelSelection')).toContainText('Editing panel 3 of 4');
  await page.locator('#headerLayouts button[data-panels="16"]').click();
  // There are two unique elevations in this mocked VCP, so display both,
  // not sixteen copies of the same elevation.
  await expect(page.locator('#panelGrid .panel-tile')).toHaveCount(2);
  await expect(page.locator('#panelGrid .panel-caption').first()).toContainText('0.5');
  await expect(page.locator('#panelGrid .panel-caption').nth(1)).toContainText('1.5');
});

test('time looping reuses prefetched native gates and supports rapid stepping',async({page})=>{
  await mockRadar(page,true);
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('ARCHIVE READY',{timeout:20000});
  await page.locator('#prevTime').click();
  await expect(page.locator('#volumeLabel')).toContainText('KMOB_TEST_VOLUME_OLDER',{timeout:10000});
  await page.locator('#nextTime').click();
  await expect(page.locator('#volumeLabel')).toContainText('KMOB_TEST_VOLUME',{timeout:10000});
  await page.locator('#playbackSpeed').selectOption('150');
  await page.locator('#playTime').click();
  await expect(page.locator('#playTime')).toContainText('Pause',{timeout:10000});
  await page.locator('#playTime').click();
  await expect(page.locator('#playTime')).toContainText('Play');
});

test('scan strip reports received tilts, latest glow, VCP and honest strategy status',async({page})=>{
  await mockRadar(page);
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('ARCHIVE READY',{timeout:20000});
  await expect(page.locator('#scanTilts .scan-tilt')).toHaveCount(2);
  await expect(page.locator('#stripVcp')).toHaveText('VCP 35');
  await expect(page.locator('#stripStrategy')).toHaveText('NONE');
  await expect(page.locator('#stripAvset')).toHaveText('AVSET OFF');
  await expect(page.locator('#scanTilts .scan-tilt.newest')).toContainText('1.5');
  await page.locator('#scanTilts .scan-tilt').first().click();
  await expect(page.locator('#angleLabel')).toContainText('0.50');
  await expect(page.locator('#scanTilts .scan-tilt.selected')).toContainText('0.5');
});

test('authoritative Message 5 SAILS and Message 2 AVSET ON appear in strip',async({page})=>{
  await mockRadar(page);
  await page.route('**/api/volumes/KMOB_TEST_VOLUME',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({...descriptor,dynamic_scan_type:'SAILS x 2',avset_enabled:true})
  }));
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('ARCHIVE READY',{timeout:20000});
  await expect(page.locator('#stripStrategy')).toContainText('SAILS');
  await expect(page.locator('#stripAvset')).toHaveText('AVSET ON');
});
test('scan progress stays live while navigating older radar time',async({page})=>{
  await mockRadar(page,true);
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('ARCHIVE READY',{timeout:20000});
  await page.locator('#prevTime').click();
  await expect(page.locator('#volumeLabel')).toContainText('KMOB_TEST_VOLUME_OLDER');
  await expect(page.locator('#stripLatest')).toContainText('1.5°');
  await expect(page.locator('#scanTilts .scan-tilt.newest')).toContainText('1.5');
});

test('performance panel shows actual backend stages and browser frame timing',async({page})=>{
  await mockRadar(page);
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('ARCHIVE READY',{timeout:20000});
  await expect(page.locator('#perfRayAge')).toHaveText('18 s');
  await expect(page.locator('#perfDiscovery')).toHaveText('12.5 ms');
  await expect(page.locator('#perfDownload')).toHaveText('83.2 ms');
  await expect(page.locator('#perfDecode')).toContainText('210.4 ms');
  await expect(page.locator('#perfTransfer')).toContainText('ms');
  await expect(page.locator('#perfFrame')).toContainText('ms');
});

test('latest-volume elevation strip includes previous complete upper tilts and arrows cross volume',async({page})=>{
  await mockRadar(page,true);
  const newest={...descriptor,volume_id:'KMOB_TEST_VOLUME',volume_complete:false,sweeps:[sweeps[0]]};
  const high={...sweeps[1],id:'sweep_2',index:2,fixed_angle_deg:2.4};
  const previous={...descriptor,volume_id:'KMOB_TEST_VOLUME_OLDER',volume_complete:true,
    sweeps:[sweeps[0],sweeps[1],high]};
  await page.route('**/api/volumes/KMOB_TEST_VOLUME',route=>route.fulfill({
    status:200,contentType:'application/json',body:JSON.stringify(newest)
  }));
  await page.route('**/api/volumes/KMOB_TEST_VOLUME_OLDER',route=>route.fulfill({
    status:200,contentType:'application/json',body:JSON.stringify(previous)
  }));
  await page.route('**/api/radar/tilts',route=>route.fulfill({
    status:200,contentType:'application/json',body:JSON.stringify({
      volume_id:newest.volume_id,previous_volume_id:previous.volume_id,volume_complete:false,
      newest:{sweep_id:'sweep_0',angle:0.5,time_utc:baseTime},
      tilts:[
        {angle:0.5,current:true,newest:true,count_current:1,time_utc:baseTime,
          moments:{REF:{volume_id:newest.volume_id,sweep_id:'sweep_0',current:true,time_utc:baseTime}}},
        {angle:1.5,current:false,newest:false,count_current:0,time_utc:baseTime,
          moments:{REF:{volume_id:previous.volume_id,sweep_id:'sweep_1',current:false,time_utc:baseTime}}},
        {angle:2.4,current:false,newest:false,count_current:0,time_utc:baseTime,
          moments:{REF:{volume_id:previous.volume_id,sweep_id:'sweep_2',current:false,time_utc:baseTime}}}
      ]
    })
  }));
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('ARCHIVE READY',{timeout:20000});
  await expect(page.locator('#scanTilts .scan-tilt')).toHaveCount(3);
  await expect(page.locator('#scanTilts .scan-tilt.prior')).toHaveCount(2);
  await expect(page.locator('#scanTilts .scan-tilt.newest')).toContainText('0.5');
  await page.locator('body').click({position:{x:1000,y:300}});
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#volumeLabel')).toContainText('KMOB_TEST_VOLUME_OLDER',{timeout:10000});
  await expect(page.locator('#angleLabel')).toContainText('1.50');
  await expect(page.locator('#scanTilts .scan-tilt.selected')).toContainText('1.5');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#angleLabel')).toContainText('2.40');
  await expect(page.locator('#scanTilts .scan-tilt.newest')).toContainText('0.5');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#angleLabel')).toContainText('1.50');
});
