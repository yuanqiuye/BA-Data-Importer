import asyncio
import json
import logging
import logging.config
import threading
import time
from dataclasses import dataclass, asdict
from typing import Any, Callable, Self, Dict, Optional

import mitmproxy
from mitmproxy import http
from mitmproxy.addons import default_addons, script
from mitmproxy.master import Master
from mitmproxy.options import Options
import requests
import argparse
import os

logging.config.dictConfig(
    {
        "version": 1,
        "disable_existing_loggers": True,
    }
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ba_data")


@dataclass
class Equipment:
    num: int
    tier: int
    Category: str
    Rarity: int


@dataclass
class Student:
    star: int
    level: int
    EX: int
    BS: int
    ES: int
    SS: int
    bond: int
    ue: int = 0
    ue_level: int = 0
    eleph: int = 0
    gear_1: int = 0
    gear_2: int = 0
    gear_3: int = 0


class GameDataCollector:
    def __init__(self):
        self.equipments_db: Dict[int, Dict] = {}
        self.students: Dict[int, Student] = {}
        self.items: Dict[int, Any] = {}
        self.equipments: Dict[int, Equipment] = {}

    def get_db(self) -> None:
        try:
            response = requests.get(
                "https://schaledb.com/data/en/equipment.min.json", timeout=10
            )
            response.raise_for_status()
            data = response.json()
            logger.info("Fetched equipment database")
            self.equipments_db = {
                item[1]["Id"]: {
                    "tier": item[1]["Tier"],
                    "Category": item[1]["Category"],
                    "Rarity": item[1]["Rarity"],
                }
                for item in data.items()
            }
        except (requests.RequestException, json.JSONDecodeError) as e:
            logger.error(f"Failed to fetch equipment database: {e}")
            raise

    def convert_account(self, rep: Dict) -> None:
        data = rep["packet"]
        self.items["Credit"] = data["AccountCurrencySyncResponse"]["AccountCurrencyDB"][
            "CurrencyDict"
        ]["Gold"]
        bound_equipments = {}

        # Process equipment
        for equipment in data["EquipmentItemListResponse"]["EquipmentDBs"]:
            if equipment_db_data := self.equipments_db.get(equipment["UniqueId"]):
                if bound_id := equipment.get("BoundCharacterServerId"):
                    bound_equipments[equipment["ServerId"]] = equipment_db_data["tier"]
                else:
                    self.equipments[equipment["UniqueId"]] = Equipment(
                        num=equipment["StackCount"], **equipment_db_data
                    )

        # Process students
        for student in data["CharacterListResponse"]["CharacterDBs"]:
            equip_tier = [
                bound_equipments.get(equipment_id, 0)
                for equipment_id in student["EquipmentServerIds"][:3]
            ]

            self.students[student["UniqueId"]] = Student(
                star=student["StarGrade"],
                level=student["Level"],
                EX=student["ExSkillLevel"],
                BS=student["PublicSkillLevel"],
                ES=student["PassiveSkillLevel"],
                SS=student["ExtraPassiveSkillLevel"],
                bond=student["FavorRank"],
                gear_1=equip_tier[0],
                gear_2=equip_tier[1],
                gear_3=equip_tier[2],
            )

        # Process weapons
        for weapon in data["CharacterListResponse"]["WeaponDBs"]:
            if student := self.students.get(weapon["UniqueId"]):
                student.ue = weapon.get("StarGrade", 0)
                student.ue_level = weapon.get("Level", 0)

    def convert_items(self, rep: Dict) -> None:
        for item in rep["packet"]["ItemDBs"]:
            item_id = item["UniqueId"]
            count = item.get("StackCount", 0)
            if student := self.students.get(item_id):
                student.eleph = count
            else:
                self.items[item_id] = count

    def create_result(self) -> None:
        result = {
            "students": {k: asdict(v) for k, v in self.students.items()},
            "items": self.items,
            "equipments": {k: asdict(v) for k, v in self.equipments.items()},
        }

        os.makedirs("data", exist_ok=True)

        filename = time.strftime("%Y%m%d_%H%M%S")
        try:
            with open(
                os.path.join("data", f"{filename}.json"), "w", encoding="utf-8"
            ) as f:
                json.dump(result, f, indent=4)
            logger.info(f"Data has been written to data/{filename}.json")
        except IOError as e:
            logger.error(f"Failed to write output file: {e}")


class Addon:
    def __init__(self, master: Master):
        self.master = master
        self.collector = GameDataCollector()

    def _schedule_shutdown(self):
        """Schedule proxy shutdown after 10 seconds in a separate thread."""
        def delayed_shutdown():
            time.sleep(10)
            logger.info("Shutting down proxy.")
            self.master.shutdown()
        
        shutdown_thread = threading.Thread(target=delayed_shutdown, daemon=True)
        shutdown_thread.start()

    def response(self, flow: http.HTTPFlow) -> None:
        if not (
            flow.request
            and flow.request.pretty_url
            == "https://nxm-tw-bagl.nexon.com:5000/api/gateway"
        ):
            return

        try:
            ba_data = flow.response.json()
            protocol = ba_data["protocol"]

            if protocol not in ("Item_List", "Account_LoginSync"):
                return

            ba_data = {"protocol": protocol, "packet": json.loads(ba_data["packet"])}

            if protocol == "Account_LoginSync":
                self.collector.get_db()
                self.collector.convert_account(ba_data)
                logger.info("Students and Equipments has done")
            elif protocol == "Item_List":
                self.collector.convert_items(ba_data)
                logger.info("Items has done")
                self.collector.create_result()
                logger.info("Data collection complete. Scheduling shutdown in 10 seconds.")
                self._schedule_shutdown()

        except Exception as e:
            logger.error(f"Error processing response: {e}", exc_info=True)


class ThreadedMitmProxy(threading.Thread):
    def __init__(self, user_addon: Callable, **options: Any) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.master = Master(Options(), event_loop=self.loop)
        self.master.addons.add(
            *(
                user_addon(self.master) if isinstance(addon, script.ScriptLoader) else addon
                for addon in default_addons()
            )
        )
        self.master.options.update(**options)
        super().__init__()

    def run(self) -> None:
        self.loop.run_until_complete(self.master.run())

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_) -> None:
        self.master.shutdown()
        self.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Start BA data collector proxy")
    parser.add_argument(
        "--port", type=int, default=14514, help="Port number for proxy server"
    )
    args = parser.parse_args()

    with ThreadedMitmProxy(Addon, listen_host="127.0.0.1", listen_port=args.port, mode=["local:BlueArchive,curl"], allow_hosts=["nxm-tw-bagl.nexon.com","mitm.it"]) as proxy:
        logger.info(f"Start proxy server on 127.0.0.1:{args.port}.")
        logger.info("Please log in to the game. The proxy will shut down automatically after collecting data.")
        proxy.join()

    logger.info("Proxy has shut down. Script finished.")