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

// A date's first harvest can be genuinely partial: late kickoffs, extra
// time, or provider lag mean not every match for that date has a final
// score yet at the moment it's first queried. Checking "does at least one
// match already exist for this date" (hasSourceDate) only proves the date
// was queried once, not that every match for it is in — trusting that to
// skip a date forever left later-finishing matches never backfilled
// (confirmed forensic finding: 129 predictions with a past kickoff still
// pending, 29 of them for a single recent date). `dates` is chronological
// (completedUtcDates' oldest-first order), so its last `recentDays` entries
// are the ones still young enough to plausibly be incomplete — callers
// should re-query those every time regardless of hasSourceDate, relying on
// sqliteHistory's INSERT OR IGNORE dedup (identityKey / match_sources
// primary key) to make repeat queries safe. Older dates in the window keep
// the fast hasSourceDate skip so harvesting stays bounded, never reloading
// history that's already definitely settled.
export function recentRefetchDates(dates,recentDays=2){
  const n=Math.max(0,Number(recentDays)||0);
  return n?new Set(dates.slice(-n)):new Set();
}
