// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {RankerRegistry} from "../src/RankerRegistry.sol";

/// Deploys RankerRegistry (no admin, no dependencies) and records it in ../deployments/<DEPLOY_NAME>.json
/// env: DEPLOYER_PRIVATE_KEY, DEPLOY_NAME
contract DeployRankerRegistry is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory path = string.concat("../deployments/", vm.envString("DEPLOY_NAME"), ".json");
        vm.startBroadcast(pk);
        RankerRegistry reg = new RankerRegistry();
        vm.stopBroadcast();
        vm.writeJson(vm.toString(address(reg)), path, ".rankerRegistry");
        console2.log("RankerRegistry", address(reg));
    }
}
