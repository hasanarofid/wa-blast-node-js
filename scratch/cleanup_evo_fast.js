const EVO_URL = "http://127.0.0.1:8080";
const EVO_APIKEY = "EVO_MANTAP_2024";

async function cleanup() {
    console.log("Fetching all instances...");
    const res = await fetch(`${EVO_URL}/instance/fetchInstances`, {
        headers: { apikey: EVO_APIKEY }
    });
    const instances = await res.json();
    console.log(`Found ${instances.length} instances.`);

    const toDelete = instances.filter(i => i.connectionStatus !== 'open');
    console.log(`Attempting to delete ${toDelete.length} stale instances in batches...`);

    const batchSize = 10;
    for (let i = 0; i < toDelete.length; i += batchSize) {
        const batch = toDelete.slice(i, i + batchSize);
        console.log(`Deleting batch ${i/batchSize + 1}...`);
        
        await Promise.all(batch.map(async (inst) => {
            try {
                await fetch(`${EVO_URL}/instance/delete/${inst.name}`, {
                    method: 'DELETE',
                    headers: { apikey: EVO_APIKEY }
                });
            } catch (err) {
                console.error(`Failed to delete ${inst.name}`);
            }
        }));
        
        // Brief pause between batches
        await new Promise(r => setTimeout(r, 500));
    }
    console.log("Cleanup finished.");
}

cleanup();
