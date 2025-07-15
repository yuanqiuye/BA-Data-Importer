// ==UserScript==
// @name        Justin import
// @description A script for easy import BA data to justin163
// @match       *://justin163.com/planner/
// @version     1.0.0
// @author      yuanqiuye
// @grant       none
// ==/UserScript==

(function () {
    'use strict';

    function promisifyRequest(request) {
        return new Promise((resolve, reject) => {
            // @ts-ignore - file size hacks
            request.oncomplete = request.onsuccess = () => resolve(request.result);
            // @ts-ignore - file size hacks
            request.onabort = request.onerror = () => reject(request.error);
        });
    }
    function createStore(dbName, storeName) {
        const request = indexedDB.open(dbName);
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        const dbp = promisifyRequest(request);
        return (txMode, callback) => dbp.then((db) => callback(db.transaction(storeName, txMode).objectStore(storeName)));
    }
    let defaultGetStoreFunc;
    function defaultGetStore() {
        if (!defaultGetStoreFunc) {
            defaultGetStoreFunc = createStore('keyval-store', 'keyval');
        }
        return defaultGetStoreFunc;
    }
    /**
     * Get a value by its key.
     *
     * @param key
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function get(key, customStore = defaultGetStore()) {
        return customStore('readonly', (store) => promisifyRequest(store.get(key)));
    }
    /**
     * Set a value with a key.
     *
     * @param key
     * @param value
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function set(key, value, customStore = defaultGetStore()) {
        return customStore('readwrite', (store) => {
            store.put(value, key);
            return promisifyRequest(store.transaction);
        });
    }
    /**
     * Set multiple values at once. This is faster than calling set() multiple times.
     * It's also atomic – if one of the pairs can't be added, none will be added.
     *
     * @param entries Array of entries, where each entry is an array of `[key, value]`.
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function setMany(entries, customStore = defaultGetStore()) {
        return customStore('readwrite', (store) => {
            entries.forEach((entry) => store.put(entry[1], entry[0]));
            return promisifyRequest(store.transaction);
        });
    }
    /**
     * Get multiple values by their keys
     *
     * @param keys
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function getMany(keys, customStore = defaultGetStore()) {
        return customStore('readonly', (store) => Promise.all(keys.map((key) => promisifyRequest(store.get(key)))));
    }
    /**
     * Update a value. This lets you see the old value and update it as an atomic operation.
     *
     * @param key
     * @param updater A callback that takes the old value and returns a new value.
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function update(key, updater, customStore = defaultGetStore()) {
        return customStore('readwrite', (store) =>
        // Need to create the promise manually.
        // If I try to chain promises, the transaction closes in browsers
        // that use a promise polyfill (IE10/11).
        new Promise((resolve, reject) => {
            store.get(key).onsuccess = function () {
                try {
                    store.put(updater(this.result), key);
                    resolve(promisifyRequest(store.transaction));
                }
                catch (err) {
                    reject(err);
                }
            };
        }));
    }
    /**
     * Delete a particular key from the store.
     *
     * @param key
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function del(key, customStore = defaultGetStore()) {
        return customStore('readwrite', (store) => {
            store.delete(key);
            return promisifyRequest(store.transaction);
        });
    }
    /**
     * Delete multiple keys at once.
     *
     * @param keys List of keys to delete.
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function delMany(keys, customStore = defaultGetStore()) {
        return customStore('readwrite', (store) => {
            keys.forEach((key) => store.delete(key));
            return promisifyRequest(store.transaction);
        });
    }
    /**
     * Clear all values in the store.
     *
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function clear(customStore = defaultGetStore()) {
        return customStore('readwrite', (store) => {
            store.clear();
            return promisifyRequest(store.transaction);
        });
    }
    function eachCursor(store, callback) {
        store.openCursor().onsuccess = function () {
            if (!this.result)
                return;
            callback(this.result);
            this.result.continue();
        };
        return promisifyRequest(store.transaction);
    }
    /**
     * Get all keys in the store.
     *
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function keys(customStore = defaultGetStore()) {
        return customStore('readonly', (store) => {
            // Fast path for modern browsers
            if (store.getAllKeys) {
                return promisifyRequest(store.getAllKeys());
            }
            const items = [];
            return eachCursor(store, (cursor) => items.push(cursor.key)).then(() => items);
        });
    }
    /**
     * Get all values in the store.
     *
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function values(customStore = defaultGetStore()) {
        return customStore('readonly', (store) => {
            // Fast path for modern browsers
            if (store.getAll) {
                return promisifyRequest(store.getAll());
            }
            const items = [];
            return eachCursor(store, (cursor) => items.push(cursor.value)).then(() => items);
        });
    }
    /**
     * Get all entries in the store. Each entry is an array of `[key, value]`.
     *
     * @param customStore Method to get a custom store. Use with caution (see the docs).
     */
    function entries(customStore = defaultGetStore()) {
        return customStore('readonly', (store) => {
            // Fast path for modern browsers
            // (although, hopefully we'll get a simpler path some day)
            if (store.getAll && store.getAllKeys) {
                return Promise.all([
                    promisifyRequest(store.getAllKeys()),
                    promisifyRequest(store.getAll()),
                ]).then(([keys, values]) => keys.map((key, i) => [key, values[i]]));
            }
            const items = [];
            return customStore('readonly', (store) => eachCursor(store, (cursor) => items.push([cursor.key, cursor.value])).then(() => items));
        });
    }

    function _asyncIterator(r) { var n, t, o, e = 2; for ("undefined" != typeof Symbol && (t = Symbol.asyncIterator, o = Symbol.iterator); e--;) { if (t && null != (n = r[t])) return n.call(r); if (o && null != (n = r[o])) return new AsyncFromSyncIterator(n.call(r)); t = "@@asyncIterator", o = "@@iterator"; } throw new TypeError("Object is not async iterable"); }
    function AsyncFromSyncIterator(r) { function AsyncFromSyncIteratorContinuation(r) { if (Object(r) !== r) return Promise.reject(new TypeError(r + " is not an object.")); var n = r.done; return Promise.resolve(r.value).then(function (r) { return { value: r, done: n }; }); } return AsyncFromSyncIterator = function (r) { this.s = r, this.n = r.next; }, AsyncFromSyncIterator.prototype = { s: null, n: null, next: function () { return AsyncFromSyncIteratorContinuation(this.n.apply(this.s, arguments)); }, return: function (r) { var n = this.s.return; return void 0 === n ? Promise.resolve({ value: r, done: !0 }) : AsyncFromSyncIteratorContinuation(n.apply(this.s, arguments)); }, throw: function (r) { var n = this.s.return; return void 0 === n ? Promise.reject(r) : AsyncFromSyncIteratorContinuation(n.apply(this.s, arguments)); } }, new AsyncFromSyncIterator(r); }
    window.onload = async function () {
      var importButton = document.querySelector('button[data-id="saving-importbutton"]');
      var newElement = document.createElement('button');
      newElement.innerHTML = "Import BA";
      newElement.setAttribute("class", "transfer-modal-button display-string");
      newElement.setAttribute("style", "left: 115px; top: 70px; background-color: #3399ff;");
      newElement.setAttribute("data-id", "saving-import");
      newElement.addEventListener("click", start_import);
      importButton.insertAdjacentElement('afterend', newElement);
      loadDataFromIDB();
    };
    async function importDataToJustin(newData) {
      var existingData = JSON.parse(localStorage.getItem('save-data'));
      var result = {};
      if ('students' in newData) {
        result = mergeStudentsData(existingData, newData);
        console.log(result);
      }
      if ('items' in newData) {
        existingData.owned_materials = {}
        result = importItemsData(existingData, newData.items);
        console.log(result);
        result = importEquipmentsData(existingData, newData.equipments);
        console.log(result);
      }
      result = JSON.stringify(result);
      localStorage.setItem('save-data', result);
      location.reload();
    }
    async function addNotificationButton(dir_ref) {
      var importButton = document.querySelector('button[data-id="button-sort"]');
      var newElement = document.createElement('button');
      newElement.innerHTML = "Get permission";
      newElement.setAttribute("class", "charEditorButton display-string");
      newElement.setAttribute("style", "background-color: #3399ff;");
      newElement.setAttribute("data-id", "get-permission");
      newElement.addEventListener("click", async () => {
        if ((await dir_ref.requestPermission()) === "granted") {
          window.alert("Success!");
          newElement.parentNode.removeChild(newElement);
          await loadDataFromIDB();
          return;
        }
        window.alert("Failed!");
      });
      importButton.insertAdjacentElement('afterend', newElement);
    }
    async function loadDataFromIDB() {
      let dir_ref = await get('dirHandle');
      if (dir_ref !== undefined) {
        if ((await dir_ref.queryPermission()) === "granted") {
          var [key, data] = await getDataFromDirRef(dir_ref);
          const lastest_key = await get("file_version");
          if (key > lastest_key) {
            await set("file_version", key);
            console.log(key);
            importDataToJustin(data);
          } else {
            console.log(`Already lastest! ${lastest_key}`);
          }
          return;
        }
        if ((await dir_ref.queryPermission()) === "prompt") {
          await addNotificationButton(dir_ref);
          console.log("Wait for confirm");
          return;
        }
      }
      console.log("None");
    }
    async function getLatestElement(dirRef) {
      let latestEntry = null;
      var _iteratorAbruptCompletion = false;
      var _didIteratorError = false;
      var _iteratorError;
      try {
        for (var _iterator = _asyncIterator(dirRef.entries()), _step; _iteratorAbruptCompletion = !(_step = await _iterator.next()).done; _iteratorAbruptCompletion = false) {
          const [key, value] = _step.value;
          {
            // Only consider JSON files with numeric filenames
            if (key.toLowerCase().endsWith('.json')) {
              const filename = key.toLowerCase().replace('.json', '');
              if (/^\d+_\d+$/.test(filename)) {
                if (!latestEntry || key > latestEntry.key) {
                  latestEntry = {
                    key,
                    value
                  };
                }
              }
            }
          }
        }
      } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
      } finally {
        try {
          if (_iteratorAbruptCompletion && _iterator.return != null) {
            await _iterator.return();
          }
        } finally {
          if (_didIteratorError) {
            throw _iteratorError;
          }
        }
      }
      return latestEntry;
    }
    async function readJsonFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = event => {
          try {
            const json = JSON.parse(event.target.result);
            resolve(json);
          } catch (error) {
            reject(error);
          }
        };
        reader.onerror = error => reject(error);
        reader.readAsText(file);
      });
    }
    async function getDataFromDirRef(dir_ref) {
      try {
        const latestElement = await getLatestElement(dir_ref);
        const key = await latestElement.key;
        const file = await latestElement.value.getFile();
        const data = await readJsonFile(file);
        return [key, data];
      } catch (e) {
        console.error(e);
      }
    }
    async function start_import() {
      try {
        const dir_ref = await window.showDirectoryPicker();
        if (!dir_ref) {
          return;
        }
        await set("dirHandle", dir_ref);
        var [key, data] = await getDataFromDirRef(dir_ref);
        await set("file_version", key);
        console.log(key);
        importDataToJustin(data);
      } catch (e) {
        console.error(e);
      }
    }
    function importEquipmentsData(existingData, equipments) {
      for (let key in equipments) {
        let item = equipments[key];
        let newId = "";
        let newNum = item.num;
        if (item.Category === "Exp") {
          let firstPart = "GXP";
          let secondPart = "";
          switch (item.Rarity) {
            case "N":
              secondPart = "1";
              break;
            case "R":
              secondPart = "2";
              break;
            case "SR":
              secondPart = "3";
              break;
            case "SSR":
              secondPart = "4";
              break;
          }
          newId = `${firstPart}_${secondPart}`;
        } else if (["Hat", "Gloves", "Shoes", "Bag", "Badge", "Hairpin", "Charm", "Watch", "Necklace"].includes(item.Category)) {
          let firstPart = `T${item.tier}`;
          let secondPart = item.Category;
          newId = `${firstPart}_${secondPart}`;
        } else if (item.Category === "WeaponExpGrowthA") {
          let firstPart = "";
          let secondPart = "Spring";
          switch (item.Rarity) {
            case "N":
              firstPart = "1";
              break;
            case "R":
              firstPart = "2";
              break;
            case "SR":
              firstPart = "3";
              break;
            case "SSR":
              firstPart = "4";
              break;
          }
          newId = `T${firstPart}_${secondPart}`;
        } else if (item.Category === "WeaponExpGrowthB") {
          let firstPart = "";
          let secondPart = "Hammer";
          switch (item.Rarity) {
            case "N":
              firstPart = "1";
              break;
            case "R":
              firstPart = "2";
              break;
            case "SR":
              firstPart = "3";
              break;
            case "SSR":
              firstPart = "4";
              break;
          }
          newId = `T${firstPart}_${secondPart}`;
        } else if (item.Category === "WeaponExpGrowthC") {
          let firstPart = "";
          let secondPart = "Barrel";
          switch (item.Rarity) {
            case "N":
              firstPart = "1";
              break;
            case "R":
              firstPart = "2";
              break;
            case "SR":
              firstPart = "3";
              break;
            case "SSR":
              firstPart = "4";
              break;
          }
          newId = `T${firstPart}_${secondPart}`;
        } else if (item.Category === "WeaponExpGrowthZ") {
          let firstPart = "";
          let secondPart = "Needle";
          switch (item.Rarity) {
            case "N":
              firstPart = "1";
              break;
            case "R":
              firstPart = "2";
              break;
            case "SR":
              firstPart = "3";
              break;
            case "SSR":
              firstPart = "4";
              break;
          }
          newId = `T${firstPart}_${secondPart}`;
        }
        existingData.owned_materials[newId] = newNum;
      }

      let gxp1 = parseInt(existingData.owned_materials["GXP_1"] || 0) * 90;
      let gxp2 = parseInt(existingData.owned_materials["GXP_2"] || 0) * 360;
      let gxp3 = parseInt(existingData.owned_materials["GXP_3"] || 0) * 1440;
      let gxp4 = parseInt(existingData.owned_materials["GXP_4"] || 0) * 5760;
      existingData.owned_materials["GearXp"] = gxp1 + gxp2 + gxp3 + gxp4;
      return existingData;
    }
    function importItemsData(existingData, items) {
      const idMap = {
        "10": "XP_1",
        "11": "XP_2",
        "12": "XP_3",
        "13": "XP_4"
      };

      // Update owned_materials with new items
      for (const key in items) {
        const item = items[key];
        const mappedId = idMap[key] || key;
        existingData.owned_materials[mappedId] = item;
      }

      // Calculate Xp
      const exp1 = parseInt(existingData.owned_materials["XP_1"] || 0);
      const exp2 = parseInt(existingData.owned_materials["XP_2"] || 0);
      const exp3 = parseInt(existingData.owned_materials["XP_3"] || 0);
      const exp4 = parseInt(existingData.owned_materials["XP_4"] || 0);
      const xp = exp1 * 50 + exp2 * 500 + exp3 * 2000 + exp4 * 10000;

      // Insert Xp into owned_materials
      existingData.owned_materials["Xp"] = xp;
      return existingData;
    }
    function mergeStudentsData(existingData, newData) {
      // Convert existingData to a dictionary for easy lookup
      const existingIds = {};
      existingData.characters.forEach(character => {
        existingIds[character.id] = character;
      });
      Object.entries(newData.students).forEach(([studentId, studentInfo]) => {
        if (existingIds[studentId]) {
          // Update the existing character's current data
          const existingCharacter = existingIds[studentId];
          existingCharacter.current = {
            level: parseInt(studentInfo.level),
            bond: parseInt(studentInfo.bond),
            star: parseInt(studentInfo.star),
            ue: parseInt(studentInfo.ue),
            ue_level: parseInt(studentInfo.ue_level),
            ex: parseInt(studentInfo.EX),
            basic: parseInt(studentInfo.BS),
            passive: parseInt(studentInfo.ES),
            sub: parseInt(studentInfo.SS),
            gear1: parseInt(studentInfo.gear_1),
            gear2: parseInt(studentInfo.gear_2),
            gear3: parseInt(studentInfo.gear_3)
          };
          existingCharacter.eleph.owned = parseInt(studentInfo.eleph);
        } else {
          // Add a new character if it doesn't exist
          const newCharacter = {
            id: studentId,
            name: studentInfo.name,
            current: {
              level: parseInt(studentInfo.level),
              bond: parseInt(studentInfo.bond),
              star: parseInt(studentInfo.star),
              ue: parseInt(studentInfo.ue),
              ue_level: parseInt(studentInfo.ue_level),
              ex: parseInt(studentInfo.EX),
              basic: parseInt(studentInfo.BS),
              passive: parseInt(studentInfo.ES),
              sub: parseInt(studentInfo.SS),
              gear1: parseInt(studentInfo.gear_1),
              gear2: parseInt(studentInfo.gear_2),
              gear3: parseInt(studentInfo.gear_3)
            },
            target: {
              level: parseInt(studentInfo.level),
              bond: parseInt(studentInfo.bond),
              star: parseInt(studentInfo.star),
              ue: parseInt(studentInfo.ue),
              ue_level: parseInt(studentInfo.ue_level),
              ex: parseInt(studentInfo.EX),
              basic: parseInt(studentInfo.BS),
              passive: parseInt(studentInfo.ES),
              sub: parseInt(studentInfo.SS),
              gear1: parseInt(studentInfo.gear_1),
              gear2: parseInt(studentInfo.gear_2),
              gear3: parseInt(studentInfo.gear_3)
            },
            eleph: {
              owned: parseInt(studentInfo.eleph),
              unlocked: true,
              cost: 1,
              purchasable: 0,
              farm_nodes: 0,
              node_refresh: false,
              use_eligma: false,
              use_shop: false
            },
            enabled: true
          };
          existingData.characters.push(newCharacter);
        }
      });
      return existingData;
    }

    })();
