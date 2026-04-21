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
    console.log(`Attempting to delete ${toDelete.length} stale instances...`);

    let count = 0;
    for (const inst of toDelete) {
        try {
            const delRes = await fetch(`${EVO_URL}/instance/delete/${inst.name}`, {
                method: 'DELETE',
                headers: { apikey: EVO_APIKEY }
            });
            const data = await delRes.json();
            count++;
            if (count % 20 === 0) {
                console.log(`Deleted ${count}/${toDelete.length}...`);
            }
        } catch (err) {
            console.error(`Failed to delete ${inst.name}:`, err.message);
        }
        // Small sleep to avoid hammering the already overloaded API
        await new Promise(r => setTimeout(r, 100));
    }
    console.log("Cleanup finished.");
}

cleanup();
