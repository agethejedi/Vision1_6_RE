export async function extractFeatures(input, ctx){
  const { adapters, network } = ctx;
  const evm = adapters?.evm;
  if (!evm) throw new Error('No EVM adapter provided');

  const base = await evm.getAddressSummary(input.id, { network });

  let local = undefined;
  if (ctx.flags?.graphSignals && evm.getLocalGraphStats) {
    try { local = await evm.getLocalGraphStats(input.id, { network }); }
    catch {}
  }

  let anomaly = undefined;
  if (evm.getAnomalySeries) {
    try { anomaly = await evm.getAnomalySeries(input.id, { network }); }
    catch {}
  }

  return { ...base, local, anomaly };
}
