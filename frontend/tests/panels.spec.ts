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
  source:'archive',sweeps
};
async function mockRadar(page:Page) {
  await page.route('**/api/**',async route=>{
    const pathname=new URL(route.request().url()).pathname.replace(/^\/api/,'');
    const json=(body:unknown)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(pathname==='/radar/status')return json({
      mode:'archive',state:'ready',latest_volume_id:descriptor.volume_id,
      age_seconds:null,last_error:null,last_check_utc:null
    });
    if(pathname==='/volumes/index')return json([{
      volume_id:descriptor.volume_id,radar_id:'KMOB',
      time_utc:baseTime,sweeps:2
    }]);
    if(pathname==='/volumes/KMOB_TEST_VOLUME')return json(descriptor);
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
  await page.goto('/');
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
  await page.goto('/');
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
