export function completedUtcDates(now=Date.now(),lookbackDays=3){
  const dates=[];
  const end=new Date(now);
  for(let offset=Math.max(1,Number(lookbackDays)||1);offset>=1;offset--){
    dates.push(new Date(Date.UTC(
      end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate()-offset
    )).toISOString().slice(0,10));
  }
  return dates;
}
