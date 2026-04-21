const EVO_URL = "http://127.0.0.1:8080";
const EVO_APIKEY = "EVO_MANTAP_2024";

async function cleanup() {
    console.log("Fetching all instances...");
    const res = await fetch(`${EVO_URL}/instance/fetchInstances`, {
        headers: { apikey: EVO_APIKEY }
    });
    const instances = await res.json();
    console.log(`Remaining instances: ${instances.length}`);

    const toDelete = instances.filter(i => i.connectionStatus !== 'open');
    console.log(`Attempting to delete ${toDelete.length} stale instances in large batches...`);

    const batchSize = 100;
    for (let i = 0; i < toDelete.length; i += batchSize) {
        const batch = toDelete.slice(i, i + batchSize);
        console.log(`Deleting batch ${Math.floor(i/batchSize) + 1} (${batch.length} instances)...`);
        
        await Promise.all(batch.map(async (inst) => {
            try {
                const r = await fetch(`${EVO_URL}/instance/delete/${inst.name}`, {
                    method: 'DELETE',
                    headers: { apikey: EVO_APIKEY }
                });
                if (!r.ok) console.error(`Error deleting ${inst.name}: ${r.statusText}`);
            } catch (err) {
                // ignore
            }
        }));
        
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log("Cleanup finished.");
}

cleanup();
