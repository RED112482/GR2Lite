/** Share parsed NOAA outlines between the full map and panel previews.
 * Requests are deduplicated even if both views initialize simultaneously.
 */
const cached=new Map<string,Promise<any>>();
export function getBoundary(root:string,kind:'states'|'counties'|'cwa'):Promise<any>{
  const url=root.replace(/\/$/,'')+'/boundaries/'+kind;
  const existing=cached.get(url);
  if(existing)return existing;
  const promise=fetch(url).then(async response=>{
    if(!response.ok)throw new Error('NOAA boundary '+kind+' HTTP '+response.status);
    const data=await response.json();
    if(data.type!=='FeatureCollection'||!Array.isArray(data.features))
      throw new Error('Invalid NOAA GeoJSON '+kind);
    return data;
  }).catch(error=>{cached.delete(url);throw error;});
  cached.set(url,promise);
  return promise;
}
