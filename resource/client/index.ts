import Config from "common/config";
import {
  Zone,
  triggerServerCallback,
  notify,
  showTextUI,
  hideTextUI,
  registerContext,
  showContext,
  skillCheck
} from "@overextended/ox_lib/client";
import { Vector3 } from "@overextended/core/vector";

// Map to avoid playing beep/lights on initial vehicle spawn/stream-in
const initializedVehicles = new Set<number>();
const spawnedPeds: number[] = [];

// Helper function to find the closest vehicle
function getClosestVehicle(): number | null {
  const ped = PlayerPedId();
  let vehicle = GetVehiclePedIsIn(ped, false);
  if (vehicle !== 0) return vehicle;

  const coords = GetEntityCoords(ped, true);
  const vehicles = GetGamePool("CVehicle");
  let closestVehicle = null;
  let minDistance = 5.0; // 5 meters maximum distance

  for (const veh of vehicles) {
    const vehCoords = GetEntityCoords(veh, true);
    const distance = Vdist(coords[0]!, coords[1]!, coords[2]!, vehCoords[0]!, vehCoords[1]!, vehCoords[2]!);
    if (distance < minDistance) {
      minDistance = distance;
      closestVehicle = veh;
    }
  }
  return closestVehicle;
}

// Play lock/unlock beep sounds and flash hazard lights
async function playLockEffects(vehicle: number, locked: boolean) {
  const soundId = GetSoundId();
  PlaySoundFromEntity(soundId, "Remote_Lock", vehicle, "CORE_NET_EVENTS", true, 0);
  ReleaseSoundId(soundId);

  // Flash hazard lights (Left + Right indicators)
  SetVehicleIndicatorLights(vehicle, 0, true);
  SetVehicleIndicatorLights(vehicle, 1, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  SetVehicleIndicatorLights(vehicle, 0, false);
  SetVehicleIndicatorLights(vehicle, 1, false);

  if (!locked) { // Flash twice for unlock
    await new Promise((resolve) => setTimeout(resolve, 200));
    SetVehicleIndicatorLights(vehicle, 0, true);
    SetVehicleIndicatorLights(vehicle, 1, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    SetVehicleIndicatorLights(vehicle, 0, false);
    SetVehicleIndicatorLights(vehicle, 1, false);
  }
}

// Watch for lock statebag changes to sync doors and play effects
AddStateBagChangeHandler("locked", null as any, async (bagName: string, key: string, value: boolean) => {
  const entityNetId = parseInt(bagName.replace("entity:", ""));
  if (isNaN(entityNetId)) return;

  const vehicle = NetworkGetEntityFromNetworkId(entityNetId);
  if (vehicle === 0 || !DoesEntityExist(vehicle)) return;

  // Sync doors
  SetVehicleDoorsLocked(vehicle, value ? 2 : 1);

  // Do not play lock beep/flash when a vehicle first spawns/streams in
  if (!initializedVehicles.has(vehicle)) {
    initializedVehicles.add(vehicle);
    return;
  }

  // Only play effects if player is relatively close to the vehicle (visual optimization)
  const playerCoords = GetEntityCoords(PlayerPedId(), true);
  const vehCoords = GetEntityCoords(vehicle, true);
  const distance = Vdist(playerCoords[0]!, playerCoords[1]!, playerCoords[2]!, vehCoords[0]!, vehCoords[1]!, vehCoords[2]!);

  if (distance <= 25.0) {
    playLockEffects(vehicle, value);
  }
});

// Watch for engine statebag changes to sync the engine
AddStateBagChangeHandler("engine", null as any, async (bagName: string, key: string, value: boolean) => {
  const entityNetId = parseInt(bagName.replace("entity:", ""));
  if (isNaN(entityNetId)) return;

  const vehicle = NetworkGetEntityFromNetworkId(entityNetId);
  if (vehicle === 0 || !DoesEntityExist(vehicle)) return;

  SetVehicleEngineOn(vehicle, value, false, true);

  const ped = PlayerPedId();
  if (GetVehiclePedIsIn(ped, false) === vehicle && GetPedInVehicleSeat(vehicle, -1) === ped) {
    notify({
      title: "Engine Control",
      description: value ? "Engine started." : "Engine stopped.",
      type: value ? "success" : "error"
    });
  }
});

// Toggle vehicle lock/unlock
function toggleVehicleLock() {
  const vehicle = getClosestVehicle();
  if (!vehicle) return;

  const vin = Entity(vehicle).state.vin;
  if (!vin) {
    notify({
      title: "Vehicle Keys",
      description: "This vehicle has no electronic lock system.",
      type: "error"
    });
    return;
  }

  const keyCount = (exports as any).ox_inventory.Search("count", "carkey", { vin: vin });
  if (keyCount > 0) {
    const ped = PlayerPedId();
    const isPlayerInVeh = GetVehiclePedIsIn(ped, false) !== 0;

    if (!isPlayerInVeh) {
      // Play key fob clicking animation
      const animDict = "anim@mp_player_intmenu@key_fob@";
      RequestAnimDict(animDict);

      let attempts = 0;
      const interval = setInterval(() => {
        if (HasAnimDictLoaded(animDict)) {
          clearInterval(interval);
          TaskPlayAnim(ped, animDict, "fob_click", 8.0, 8.0, -1, 48, 0, false, false, false);
        } else {
          attempts++;
          if (attempts > 10) clearInterval(interval);
        }
      }, 50);
    }

    const netId = NetworkGetNetworkIdFromEntity(vehicle);
    TriggerServerEvent("ox_vehiclekeys:toggleLock", netId);
  } else {
    notify({
      title: "Vehicle Keys",
      description: "You do not have the key for this vehicle.",
      type: "error"
    });
  }
}

// Toggle vehicle engine start/stop
function toggleVehicleEngine() {
  const ped = PlayerPedId();
  const vehicle = GetVehiclePedIsIn(ped, false);

  if (vehicle === 0 || GetPedInVehicleSeat(vehicle, -1) !== ped) return;

  const vin = Entity(vehicle).state.vin;
  if (!vin) return;

  const hasKey = (exports as any).ox_inventory.Search("count", "carkey", { vin: vin }) > 0;
  const isHotwired = Entity(vehicle).state.hotwired || false;

  if (!hasKey && !isHotwired) {
    notify({
      title: "Engine Control",
      description: "You do not have the keys to start the engine.",
      type: "error"
    });
    return;
  }

  const netId = NetworkGetNetworkIdFromEntity(vehicle);
  TriggerServerEvent("ox_vehiclekeys:toggleEngine", netId);
}

// Engine blocking and hotwire monitor
let engineMonitorTick: number | null = null;
let currentMonitoredVehicle: number | null = null;

function stopEngineMonitor() {
  if (engineMonitorTick !== null) {
    clearTick(engineMonitorTick);
    engineMonitorTick = null;
  }
  currentMonitoredVehicle = null;
}

function startEngineMonitor(vehicle: number) {
  if (engineMonitorTick !== null) return;
  currentMonitoredVehicle = vehicle;

  engineMonitorTick = setTick(() => {
    const ped = PlayerPedId();
    const currentVehicle = GetVehiclePedIsIn(ped, false);

    if (currentVehicle === 0 || GetPedInVehicleSeat(currentVehicle, -1) !== ped) {
      stopEngineMonitor();
      return;
    }

    const vin = Entity(currentVehicle).state.vin;
    if (!vin) return;

    const hasKey = (exports as any).ox_inventory.Search("count", "carkey", { vin: vin }) > 0;
    const isHotwired = Entity(currentVehicle).state.hotwired || false;
    const isEngineRunning = Entity(currentVehicle).state.engine || false;

    // Case 1: No key and not hotwired
    if (!hasKey && !isHotwired) {
      SetVehicleEngineOn(currentVehicle, false, true, true);
      DisableControlAction(0, 71, true); // INPUT_VEH_ACCELERATE
      DisableControlAction(0, 72, true); // INPUT_VEH_BRAKE

      if (IsDisabledControlJustPressed(0, 71)) {
        notify({
          title: "Vehicle Keys",
          description: `You do not have the keys. Press [${Config.hotwireKey || "H"}] to hotwire.`,
          type: "error"
        });
      }
      return;
    }

    // Case 2: Has key/hotwired, but engine is manually toggled OFF
    if (!isEngineRunning) {
      SetVehicleEngineOn(currentVehicle, false, true, true);
      DisableControlAction(0, 71, true); // Prevent rolling/accelerating with engine off
      DisableControlAction(0, 72, true);
    } else {
      // Ensure engine stays ON
      SetVehicleEngineOn(currentVehicle, true, false, true);
    }
  });
}

// Hotwire action
async function toggleHotwire() {
  const ped = PlayerPedId();
  const vehicle = GetVehiclePedIsIn(ped, false);

  if (vehicle === 0 || GetPedInVehicleSeat(vehicle, -1) !== ped) return;

  const vin = Entity(vehicle).state.vin;
  if (!vin) return;

  const hasKey = (exports as any).ox_inventory.Search("count", "carkey", { vin: vin }) > 0;
  if (hasKey) {
    notify({
      title: "Vehicle Keys",
      description: "You already have the keys for this vehicle.",
      type: "info"
    });
    return;
  }

  if (Entity(vehicle).state.hotwired) {
    notify({
      title: "Vehicle Keys",
      description: "This vehicle is already hotwired.",
      type: "info"
    });
    return;
  }

  // Start hotwiring animation scenario
  TaskStartScenarioInPlace(ped, "PROP_HUMAN_BUM_BIN", 0, true);

  notify({
    title: "Hotwiring",
    description: "Attempting to hotwire the ignition...",
    type: "info"
  });

  // Run skillcheck
  const success = await skillCheck(["medium", "easy", "medium"], ["w", "a", "s", "d"]);

  ClearPedTasks(ped);

  if (success) {
    const netId = NetworkGetNetworkIdFromEntity(vehicle);
    TriggerServerEvent("ox_vehiclekeys:setHotwired", netId, true);
    notify({
      title: "Success",
      description: "You have hotwired the vehicle ignition!",
      type: "success"
    });
  } else {
    notify({
      title: "Failed",
      description: "You failed to hotwire the vehicle.",
      type: "error"
    });
  }
}

// Locksmith menu UI
async function openLocksmithMenu(locksmith: any) {
  hideTextUI();

  notify({
    title: "Locksmith",
    description: "Accessing vehicle database...",
    type: "info"
  });

  const vehicles = await triggerServerCallback("ox_vehiclekeys:getOwnedVehicles", null);

  if (!vehicles || (vehicles as any).length === 0) {
    notify({
      title: "Locksmith",
      description: "You do not own any registered vehicles.",
      type: "error"
    });
    return;
  }

  const options: any[] = (vehicles as any).map((veh: any) => {
    return {
      title: `${veh.model || "Vehicle"} (${veh.plate})`,
      description: `Duplicate Key - $${locksmith.keyCost || 100}\nVIN: ${veh.vin}`,
      onSelect: async () => {
        const result = await triggerServerCallback("ox_vehiclekeys:buyKey", null, veh.vin, veh.plate);
        if (result && (result as any).success) {
          notify({
            title: "Success",
            description: `Purchased a new key for vehicle ${veh.plate}!`,
            type: "success"
          });
        } else {
          notify({
            title: "Failed",
            description: (result as any)?.reason || "Failed to purchase key.",
            type: "error"
          });
        }
      }
    };
  });

  registerContext({
    id: "locksmith_menu",
    title: "Locksmith Services",
    options: options
  });

  showContext("locksmith_menu");
}

// Spawn locksmith peds, blips and interaction zones
function spawnLocksmiths() {
  if (!Config.locksmiths) return;

  for (const locksmith of Config.locksmiths) {
    if (!locksmith.coords) continue;
    // 1. Blip
    if (locksmith.blip?.enabled) {
      const blip = AddBlipForCoord(locksmith.coords[0], locksmith.coords[1], locksmith.coords[2]);
      SetBlipSprite(blip, locksmith.blip.sprite || 134);
      SetBlipColour(blip, locksmith.blip.color || 3);
      SetBlipScale(blip, locksmith.blip.scale || 0.8);
      SetBlipAsShortRange(blip, true);
      BeginTextCommandSetBlipName("STRING");
      AddTextComponentString(locksmith.blip.label || "Locksmith");
      EndTextCommandSetBlipName(blip);
    }

    // 2. Spawn Ped
    if (Config.enableLocksmithPeds && locksmith.ped) {
      const modelHash = GetHashKey(locksmith.ped);
      RequestModel(modelHash);

      let attempts = 0;
      const interval = setInterval(() => {
        if (HasModelLoaded(modelHash)) {
          clearInterval(interval);
          const ped = CreatePed(
            4,
            modelHash,
            locksmith.coords[0],
            locksmith.coords[1],
            locksmith.coords[2] - 1.0,
            locksmith.coords[3] || 0.0,
            false,
            true
          );
          SetEntityAsMissionEntity(ped, true, true);
          SetBlockingOfNonTemporaryEvents(ped, true);
          FreezeEntityPosition(ped, true);
          SetEntityInvincible(ped, true);
          spawnedPeds.push(ped);
          SetModelAsNoLongerNeeded(modelHash);
        } else {
          attempts++;
          if (attempts > 10) {
            clearInterval(interval);
            console.error(`[^1ox_vehiclekeys^7] Failed to load ped model: ${locksmith.ped}`);
          }
        }
      }, 100);
    }

    // 3. Create Sphere Zone (casted to any to avoid Vector3 duplicate type issues in TS compiler)
    const zoneCoords = new Vector3(locksmith.coords[0], locksmith.coords[1], locksmith.coords[2]);
    const locksmithZone = Zone.Sphere(zoneCoords as any, 2.0);

    let isInside = false;

    locksmithZone.onEnter = () => {
      isInside = true;
      showTextUI("[E] Locksmith");

      // Monitor E key press inside the zone
      const checkKeyTick = setTick(() => {
        if (!isInside) {
          clearTick(checkKeyTick);
          return;
        }

        if (IsControlJustPressed(0, 38)) { // E Key
          openLocksmithMenu(locksmith);
        }
      });
    };

    locksmithZone.onExit = () => {
      isInside = false;
      hideTextUI();
    };
  }
}

// Slow 1-second interval loop to monitor vehicle seats and enforce no-auto-shuffle
setInterval(() => {
  const ped = PlayerPedId();

  // Set CPED_CONFIG_FLAG_PreventBehaviorToShuffleToDriverSeat to prevent auto-shuffle
  SetPedConfigFlag(ped, 184, true);

  const vehicle = GetVehiclePedIsIn(ped, false);
  if (vehicle !== 0 && GetPedInVehicleSeat(vehicle, -1) === ped) {
    if (currentMonitoredVehicle !== vehicle) {
      startEngineMonitor(vehicle);
    }
  } else {
    if (engineMonitorTick !== null) {
      stopEngineMonitor();
    }
  }
}, 1000);

// Initialize Locksmiths
spawnLocksmiths();

// Key Mappings (allows players to configure their bindings in GTA V settings)
RegisterCommand("togglelock", () => {
  toggleVehicleLock();
}, false);
RegisterKeyMapping("togglelock", "Toggle Vehicle Lock", "keyboard", Config.lockKey || "L");

RegisterCommand("toggleengine", () => {
  toggleVehicleEngine();
}, false);
RegisterKeyMapping("toggleengine", "Toggle Vehicle Engine", "keyboard", Config.engineKey || "G");

RegisterCommand("hotwire", () => {
  toggleHotwire();
}, false);
RegisterKeyMapping("hotwire", "Hotwire Vehicle", "keyboard", Config.hotwireKey || "H");

// Seat shuffle command /shuff (allows manual seat sliding)
RegisterCommand("shuff", () => {
  const ped = PlayerPedId();
  const vehicle = GetVehiclePedIsIn(ped, false);
  if (vehicle !== 0) {
    // Enable auto-shuffle temporarily to let GTA slide the ped over
    SetPedConfigFlag(ped, 184, false);
    TaskShuffleToNextVehicleSeat(ped, vehicle);

    // Re-disable auto-shuffle after 3 seconds
    setTimeout(() => {
      SetPedConfigFlag(ped, 184, true);
    }, 3000);
  }
}, false);

// Cleanup peds on resource stop
on("onResourceStop", (resourceName: string) => {
  if (GetCurrentResourceName() !== resourceName) return;
  for (const ped of spawnedPeds) {
    if (DoesEntityExist(ped)) {
      DeleteEntity(ped);
    }
  }
});
