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
import Locale from "common/locale";

// Map to avoid playing beep/lights on initial vehicle spawn/stream-in
const initializedVehicles = new Set<number>();
const spawnedPeds: number[] = [];
const temporaryKeys = new Set<string>();

function playerHasKey(vin: string): boolean {
  if (temporaryKeys.has(vin)) return true;
  const count = (exports as any).ox_inventory.Search("count", "carkey", { vin: vin });
  return count > 0;
}

exports("AddKey", (vin: string) => {
  temporaryKeys.add(vin);
  TriggerServerEvent("ox_vehiclekeys:addTempKey", vin);
});

exports("RemoveKey", (vin: string) => {
  temporaryKeys.delete(vin);
  TriggerServerEvent("ox_vehiclekeys:removeTempKey", vin);
});

exports("HasKey", (vin: string) => {
  return playerHasKey(vin);
});

onNet("ox_vehiclekeys:addTempKey", (vin: string) => {
  temporaryKeys.add(vin);
});

onNet("ox_vehiclekeys:removeTempKey", (vin: string) => {
  temporaryKeys.delete(vin);
});

// Helper function to find the closest vehicle
function getClosestVehicle(): number | null {
  const ped = PlayerPedId();
  let vehicle = GetVehiclePedIsIn(ped, false);
  if (vehicle !== 0) return vehicle;

  const coords = GetEntityCoords(ped, true);
  const [cx = 0.0, cy = 0.0, cz = 0.0] = coords;
  const vehicles = GetGamePool("CVehicle");
  let closestVehicle = null;
  let minDistance = 5.0; // 5 meters maximum distance

  for (const veh of vehicles) {
    const vehCoords = GetEntityCoords(veh, true);
    const [vx = 0.0, vy = 0.0, vz = 0.0] = vehCoords;
    const distance = Vdist(cx, cy, cz, vx, vy, vz);
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
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
  SetVehicleIndicatorLights(vehicle, 0, false);
  SetVehicleIndicatorLights(vehicle, 1, false);

  if (!locked) { // Flash twice for unlock
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    SetVehicleIndicatorLights(vehicle, 0, true);
    SetVehicleIndicatorLights(vehicle, 1, true);
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
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
  const [px = 0.0, py = 0.0, pz = 0.0] = playerCoords;
  const vehCoords = GetEntityCoords(vehicle, true);
  const [vx = 0.0, vy = 0.0, vz = 0.0] = vehCoords;
  const distance = Vdist(px, py, pz, vx, vy, vz);

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
      title: Locale("ui.engine_control"),
      description: value ? Locale("success.engine_started") : Locale("success.engine_stopped"),
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
      title: Locale("ui.vehicle_keys"),
      description: Locale("error.no_lock_system"),
      type: "error"
    });
    return;
  }

  if (playerHasKey(vin)) {
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
      title: Locale("ui.vehicle_keys"),
      description: Locale("error.no_key_lock"),
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

  const hasKey = playerHasKey(vin);
  const isHotwired = Entity(vehicle).state.hotwired || false;

  if (!hasKey && !isHotwired) {
    notify({
      title: Locale("ui.engine_control"),
      description: Locale("error.no_key_engine"),
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

    const hasKey = playerHasKey(vin);
    const isHotwired = Entity(currentVehicle).state.hotwired || false;
    const isEngineRunning = Entity(currentVehicle).state.engine || false;

    // Case 1: No key and not hotwired
    if (!hasKey && !isHotwired) {
      SetVehicleEngineOn(currentVehicle, false, true, true);
      DisableControlAction(0, 71, true); // INPUT_VEH_ACCELERATE
      DisableControlAction(0, 72, true); // INPUT_VEH_BRAKE

      if (IsDisabledControlJustPressed(0, 71)) {
        notify({
          title: Locale("ui.vehicle_keys"),
          description: Locale("error.no_keys_hotwire", Config.hotwireKey || "H"),
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

  const hasKey = playerHasKey(vin);
  if (hasKey) {
    notify({
      title: Locale("ui.vehicle_keys"),
      description: Locale("error.already_has_key"),
      type: "inform"
    });
    return;
  }

  if (Entity(vehicle).state.hotwired) {
    notify({
      title: Locale("ui.vehicle_keys"),
      description: Locale("error.already_hotwired"),
      type: "inform"
    });
    return;
  }

  // Start hotwiring animation scenario
  TaskStartScenarioInPlace(ped, "PROP_HUMAN_BUM_BIN", 0, true);

  notify({
    title: Locale("ui.hotwiring_title"),
    description: Locale("info.hotwiring"),
    type: "inform"
  });

  // Run skillcheck
  const success = await skillCheck(["medium", "easy", "medium"], ["w", "a", "s", "d"]);

  ClearPedTasks(ped);

  if (success) {
    const netId = NetworkGetNetworkIdFromEntity(vehicle);
    TriggerServerEvent("ox_vehiclekeys:setHotwired", netId, true);
    notify({
      title: Locale("ui.success_title"),
      description: Locale("success.hotwired"),
      type: "success"
    });
  } else {
    notify({
      title: Locale("ui.failed_title"),
      description: Locale("error.hotwire_failed"),
      type: "error"
    });
  }
}

// Locksmith menu UI
async function openLocksmithMenu(locksmith: any) {
  hideTextUI();

  notify({
    title: Locale("ui.locksmith_title"),
    description: Locale("info.locksmith_db"),
    type: "inform"
  });

  const vehicles = await triggerServerCallback("ox_vehiclekeys:getOwnedVehicles", null);

  if (!vehicles || (vehicles as any).length === 0) {
    notify({
      title: Locale("ui.locksmith_title"),
      description: Locale("error.no_owned_vehicles"),
      type: "error"
    });
    return;
  }

  const options: any[] = (vehicles as any).map((veh: any) => {
    return {
      title: Locale("ui.locksmith_option_title", veh.model || "Vehicle", veh.plate),
      description: Locale("ui.locksmith_option_desc", String(locksmith.keyCost || 100), veh.vin),
      onSelect: async () => {
        const result = await triggerServerCallback("ox_vehiclekeys:buyKey", null, veh.vin, veh.plate);
        if (result && (result as any).success) {
          notify({
            title: Locale("ui.success_title"),
            description: Locale("success.buy_key", veh.plate),
            type: "success"
          });
        } else {
          // Translate known errors
          const rawReason = (result as any)?.reason || "Failed to purchase key";
          const reasonKey = `error.${rawReason.toLowerCase().replace(/\s+/g, "_")}`;
          let errorMsg = Locale(reasonKey as any);
          if (errorMsg === reasonKey) {
            errorMsg = rawReason;
          }
          notify({
            title: Locale("ui.failed_title"),
            description: errorMsg,
            type: "error"
          });
        }
      }
    };
  });

  registerContext({
    id: "locksmith_menu",
    title: Locale("ui.locksmith_menu_title"),
    options: options
  });

  showContext("locksmith_menu");
}

// Spawn locksmith peds, blips and interaction zones
function spawnLocksmiths() {
  if (!Config.locksmiths) return;

  for (const locksmith of Config.locksmiths) {
    if (!locksmith.coords) continue;
    const [lx = 0.0, ly = 0.0, lz = 0.0, lh = 0.0] = locksmith.coords;

    // 1. Blip
    if (locksmith.blip?.enabled) {
      const blip = AddBlipForCoord(lx, ly, lz);
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
            lx,
            ly,
            lz - 1.0,
            lh,
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
    const zoneCoords = new Vector3(lx, ly, lz);
    const locksmithZone = Zone.Sphere(zoneCoords as any, 2.0);

    let isInside = false;

    locksmithZone.onEnter = () => {
      isInside = true;
      showTextUI(Locale("ui.textui_locksmith"));

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

// Lockpicking System Minigames and Events
const minigames: Record<string, (item: string, config: any) => Promise<boolean>> = {
  ox_lib: async (item, config) => {
    return await skillCheck(config.difficulty || ["medium", "easy"], config.keys || ["w", "a", "s", "d"]);
  }
};

exports("registerMinigame", (name: string, handler: (item: string, config: any) => Promise<boolean>) => {
  minigames[name] = handler;
});

async function startLockpicking(itemName: string) {
  const itemsConfig = (Config as any).lockpicking?.items;
  if (!itemsConfig || !itemsConfig[itemName]) return;

  const itemData = itemsConfig[itemName];
  const ped = PlayerPedId();
  let vehicle = GetVehiclePedIsIn(ped, false);

  if (vehicle === 0) {
    const coords = GetEntityCoords(ped, true);
    const [cx = 0.0, cy = 0.0, cz = 0.0] = coords;
    const vehicles = GetGamePool("CVehicle");
    let closestVehicle = 0;
    let minDistance = 2.5;

    for (const veh of vehicles) {
      const vehCoords = GetEntityCoords(veh, true);
      const [vx = 0.0, vy = 0.0, vz = 0.0] = vehCoords;
      const distance = Vdist(cx, cy, cz, vx, vy, vz);
      if (distance < minDistance) {
        minDistance = distance;
        closestVehicle = veh;
      }
    }
    vehicle = closestVehicle;
  }

  if (vehicle === 0 || !DoesEntityExist(vehicle)) {
    notify({
      title: Locale("ui.lockpicking_title"),
      description: Locale("error.no_vehicle_nearby"),
      type: "error"
    });
    return;
  }

  const isLocked = Entity(vehicle).state.locked || false;
  if (!isLocked) {
    notify({
      title: Locale("ui.lockpicking_title"),
      description: Locale("error.veh_already_unlocked"),
      type: "inform"
    });
    return;
  }

  const isInside = GetVehiclePedIsIn(ped, false) !== 0;
  if (isInside) {
    const animDict = "anim@amb@clubhouse@tutorial@bkr_tut_ig3@";
    RequestAnimDict(animDict);
    let attempts = 0;
    const interval = setInterval(() => {
      if (HasAnimDictLoaded(animDict)) {
        clearInterval(interval);
        TaskPlayAnim(ped, animDict, "machinery_contrl_loop_player", 8.0, 8.0, -1, 49, 0, false, false, false);
      } else {
        attempts++;
        if (attempts > 10) clearInterval(interval);
      }
    }, 50);
  } else {
    TaskStartScenarioInPlace(ped, "WORLD_HUMAN_WELDING", 0, true);
  }

  notify({
    title: Locale("ui.lockpicking_title"),
    description: Locale("info.lockpicking_started"),
    type: "inform"
  });

  const minigameName = itemData.minigame || "ox_lib";
  const minigameHandler = minigames[minigameName];
  let success = false;

  if (minigameHandler) {
    try {
      success = await minigameHandler(itemName, itemData);
    } catch (err) {
      console.error(`[^1ox_vehiclekeys^7] Error running minigame ${minigameName}:`, err);
    }
  } else {
    console.error(`[^1ox_vehiclekeys^7] Minigame handler '${minigameName}' not found!`);
  }

  ClearPedTasks(ped);

  const netId = NetworkGetNetworkIdFromEntity(vehicle);
  TriggerServerEvent("ox_vehiclekeys:lockpickComplete", netId, itemName, success);
}

on("ox_vehiclekeys:useLockpick", (data: { name: string }) => {
  if (data && data.name) {
    startLockpicking(data.name);
  }
});

onNet("ox_vehiclekeys:lockpickResult", (success: boolean, broke: boolean, itemName: string) => {
  const itemsConfig = (Config as any).lockpicking?.items;
  const label = itemsConfig?.[itemName]?.label || itemName;

  if (success) {
    notify({
      title: Locale("ui.lockpicking_title"),
      description: Locale("success.lockpick_success"),
      type: "success"
    });
  } else if (broke) {
    notify({
      title: Locale("ui.lockpicking_title"),
      description: Locale("error.lockpick_broke", label),
      type: "error"
    });
  } else {
    notify({
      title: Locale("ui.lockpicking_title"),
      description: Locale("error.lockpick_failed"),
      type: "error"
    });
  }
});

// Cleanup peds on resource stop
on("onResourceStop", (resourceName: string) => {
  if (GetCurrentResourceName() !== resourceName) return;
  for (const ped of spawnedPeds) {
    if (DoesEntityExist(ped)) {
      DeleteEntity(ped);
    }
  }
});
