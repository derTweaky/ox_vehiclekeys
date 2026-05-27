import { onClientCallback } from "@overextended/ox_lib/server";
import Locale from "common/locale";

// Helper function to generate a pseudo-VIN (Vehicle Identification Number)
function generateVin(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let vin = "";
  for (let i = 0; i < 17; i++) {
    vin += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return vin;
}

// Map to track processed entity IDs temporarily to avoid double processing
const processedEntities = new Set<number>();

// Listen to entity creation to assign VIN to vehicles on spawn
on("entityCreated", async (entity: number) => {
  if (processedEntities.has(entity)) return;

  // We only care about vehicles
  if (GetEntityType(entity) !== 2) return;

  processedEntities.add(entity);

  // Wait a short moment for the vehicle plate to initialize
  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (!DoesEntityExist(entity)) {
    processedEntities.delete(entity);
    return;
  }

  const plate = GetVehicleNumberPlateText(entity)?.trim();
  if (!plate) {
    processedEntities.delete(entity);
    return;
  }

  // Query database to find if this vehicle exists in ox_core vehicles
  let vin = "";
  try {
    const result = await (exports as any).oxmysql.single(
      "SELECT vin FROM vehicles WHERE plate = ?",
      [plate]
    );

    if (result && result.vin) {
      vin = result.vin;
    }
  } catch (error) {
    console.error(`[^1ox_vehiclekeys^7] Failed to query database for vehicle plate: ${plate}`, error);
  }

  // If no registered VIN in database, generate a random one (for ambient/non-owned cars)
  if (!vin) {
    vin = generateVin();
  }

  // Assign the VIN to the vehicle entity's statebag (replicates to all clients)
  const vehicleState = Entity(entity).state;
  vehicleState.vin = vin;

  // Initialize the lock and engine state bags
  // Ambient vehicles default to unlocked, owned vehicles read their lock state or default to locked (true)
  const isAmbient = !plate || plate.trim() === "";
  vehicleState.locked = !isAmbient;
  vehicleState.engine = false;

  processedEntities.delete(entity);
});

// Server event to toggle locking
onNet("ox_vehiclekeys:toggleLock", (vehicleNetId: number) => {
  const source = (global as any).source;
  const vehicle = NetworkGetEntityFromNetworkId(vehicleNetId);

  if (vehicle === 0 || !DoesEntityExist(vehicle)) return;

  const vin = Entity(vehicle).state.vin;
  if (!vin) return;

  // Verify player actually has the key for this vehicle on the server side
  const hasKey = (exports as any).ox_inventory.Search(source, "count", "carkey", { vin: vin }) > 0;
  if (!hasKey) {
    console.log(`[ox_vehiclekeys] Player ${source} attempted to lock/unlock vehicle ${vehicle} without a key!`);
    return;
  }

  const currentState = Entity(vehicle).state.locked || false;
  Entity(vehicle).state.locked = !currentState;
});

// Server event to toggle engine state
onNet("ox_vehiclekeys:toggleEngine", (vehicleNetId: number) => {
  const source = (global as any).source;
  const vehicle = NetworkGetEntityFromNetworkId(vehicleNetId);

  if (vehicle === 0 || !DoesEntityExist(vehicle)) return;

  // Verify player is driver of the vehicle
  const ped = GetPlayerPed(source.toString());
  if (GetPedInVehicleSeat(vehicle, -1) !== ped) return;

  const vin = Entity(vehicle).state.vin;
  if (!vin) return;

  // Check key or hotwire
  const hasKey = (exports as any).ox_inventory.Search(source, "count", "carkey", { vin: vin }) > 0;
  const isHotwired = Entity(vehicle).state.hotwired || false;

  if (!hasKey && !isHotwired) return;

  const currentEngineState = Entity(vehicle).state.engine || false;
  Entity(vehicle).state.engine = !currentEngineState;
});

// Server event to set hotwired state
onNet("ox_vehiclekeys:setHotwired", (vehicleNetId: number, state: boolean) => {
  const source = (global as any).source;
  const vehicle = NetworkGetEntityFromNetworkId(vehicleNetId);

  if (vehicle === 0 || !DoesEntityExist(vehicle)) return;

  // Verify player is inside the vehicle (prevent exploiting from outside)
  const ped = GetPlayerPed(source.toString());
  const vehiclePedIsIn = GetVehiclePedIsIn(ped, false);

  if (vehiclePedIsIn !== vehicle) {
    console.log(`[ox_vehiclekeys] Player ${source} attempted to hotwire vehicle ${vehicle} while not inside!`);
    return;
  }

  Entity(vehicle).state.hotwired = state;
});

// ox_lib Callbacks
onClientCallback("ox_vehiclekeys:getOwnedVehicles", async (source: number) => {
  const player = (exports as any).ox_core.GetPlayer(source);
  if (!player || !player.charId) return [];

  try {
    const vehicles = await (exports as any).oxmysql.query(
      "SELECT plate, vin, model FROM vehicles WHERE owner = ?",
      [player.charId]
    );
    return vehicles || [];
  } catch (error) {
    console.error(`[^1ox_vehiclekeys^7] Failed to fetch owned vehicles for charId ${player.charId}`, error);
    return [];
  }
});

onClientCallback("ox_vehiclekeys:buyKey", async (source: number, vin: string, plate: string) => {
  const player = (exports as any).ox_core.GetPlayer(source);
  if (!player || !player.charId) {
    return { success: false, reason: "Player not loaded" };
  }

  // Check ownership
  try {
    const result = await (exports as any).oxmysql.single(
      "SELECT owner FROM vehicles WHERE vin = ? AND owner = ?",
      [vin, player.charId]
    );

    if (!result) {
      return { success: false, reason: "You do not own this vehicle" };
    }

    const keyCost = 100;

    // Check inventory cash
    const cash = (exports as any).ox_inventory.GetItem(source, "money", null, true);
    if (cash < keyCost) {
      return { success: false, reason: "Insufficient funds" };
    }

    // Deduct cash
    const removed = (exports as any).ox_inventory.RemoveItem(source, "money", keyCost);
    if (!removed) {
      return { success: false, reason: "Failed to deduct cash" };
    }

    // Give key item with metadata
    const given = (exports as any).ox_inventory.AddItem(source, "carkey", 1, {
      vin: vin,
      description: Locale("ui.key_description", plate)
    });

    if (!given) {
      // Refund cash if inventory add fails
      (exports as any).ox_inventory.AddItem(source, "money", keyCost);
      return { success: false, reason: "Inventory full" };
    }

    return { success: true };
  } catch (error) {
    console.error(`[^1ox_vehiclekeys^7] Error during key purchase for vin ${vin}`, error);
    return { success: false, reason: "Database error" };
  }
});
