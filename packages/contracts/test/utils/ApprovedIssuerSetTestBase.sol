// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";

import { SNARK_SCALAR_FIELD } from "@zk-kit/lean-imt.sol/Constants.sol";
import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { BabyJubjubTestKeys } from "./BabyJubjubTestKeys.sol";
import { TestBase } from "./TestBase.sol";

/// @dev Shared fixture. The signing keys are `k * Base8` on Baby Jubjub for k in 1..10, so every one
/// is genuinely on the curve; regenerate them with the zk-kit baby-jubjub package if they change.
///
/// The registry is wired to `issuerSet` the way production wires it, so a test that removes a member
/// through the registry exercises the real call into {ApprovedIssuerSet-retireAllIssuerKeys}.
/// {_retireAll} is a shortcut for the tests that want to reach retirement directly, without a member
/// admitted through the registry at all.
abstract contract ApprovedIssuerSetTestBase is TestBase, BabyJubjubTestKeys {
    NetworkMemberRegistry public registry;
    ApprovedIssuerSet public issuerSet;

    address owner;
    Vm.Wallet networkMember;
    bytes32 memberNetworkId;

    Vm.Wallet otherMember;
    bytes32 otherMemberNetworkId;

    uint256[10] internal keyX;
    uint256[10] internal keyY;

    function setUp() public {
        owner = makeAddr("governance");
        registry = new NetworkMemberRegistry(owner);
        issuerSet = new ApprovedIssuerSet(address(registry));

        vm.prank(owner);
        registry.setApprovedIssuerSet(address(issuerSet));

        networkMember = vm.createWallet("networkMember");
        memberNetworkId = keccak256(abi.encodePacked(networkMember.publicKeyX, networkMember.publicKeyY));

        otherMember = vm.createWallet("otherNetworkMember");
        otherMemberNetworkId = keccak256(abi.encodePacked(otherMember.publicKeyX, otherMember.publicKeyY));

        _seedCurvePoints();
    }

    /// @dev Baby Jubjub's eight low-order points, every one of which satisfies the curve equation.
    /// Enumerated by solving the curve for each x and keeping the points where `8P` is the identity.
    function _lowOrderPoints() internal pure returns (uint256[2][8] memory points) {
        points[0] = [uint256(0), 1];
        points[1] = [
            uint256(0),
            21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_616
        ];
        points[2] = [
            2_957_874_849_018_779_266_517_920_829_765_869_116_077_630_550_401_372_566_248_359_756_137_677_864_698,
            uint256(0)
        ];
        points[3] = [
            18_930_368_022_820_495_955_728_484_915_491_405_972_470_733_850_014_661_777_449_844_430_438_130_630_919,
            uint256(0)
        ];
        points[4] = [
            4_342_719_913_949_491_028_786_768_530_115_087_822_524_712_248_835_451_589_697_801_404_893_164_183_326,
            4_826_523_245_007_015_323_400_664_741_523_384_119_579_596_407_052_839_571_721_035_538_011_798_951_543
        ];
        points[5] = [
            4_342_719_913_949_491_028_786_768_530_115_087_822_524_712_248_835_451_589_697_801_404_893_164_183_326,
            17_061_719_626_832_259_898_845_741_003_733_890_968_968_767_993_363_194_771_977_168_648_564_009_544_074
        ];
        points[6] = [
            17_545_522_957_889_784_193_459_637_215_142_187_266_023_652_151_580_582_754_000_402_781_682_644_312_291,
            4_826_523_245_007_015_323_400_664_741_523_384_119_579_596_407_052_839_571_721_035_538_011_798_951_543
        ];
        points[7] = [
            17_545_522_957_889_784_193_459_637_215_142_187_266_023_652_151_580_582_754_000_402_781_682_644_312_291,
            17_061_719_626_832_259_898_845_741_003_733_890_968_968_767_993_363_194_771_977_168_648_564_009_544_074
        ];
    }

    /// @dev Approves `id`, which must be `memberNetworkId` or `otherMemberNetworkId`, deriving
    /// deterministic per-member admission fields from it so callers don't have to thread them through.
    function _approveMember(bytes32 id) internal {
        Vm.Wallet memory member = id == memberNetworkId ? networkMember : otherMember;
        vm.prank(owner);
        registry.approveNetworkMember(
            member.publicKeyX, member.publicKeyY, _semaphoreCommitmentFor(id), _governanceSignerFor(id)
        );
    }

    /// @dev Publishes the k-th curve point as the member's signing key.
    function _publish(bytes32 id, uint256 k) internal returns (uint256) {
        vm.prank(registry.networkMemberAuthAddress(id));
        return issuerSet.publishIssuerKey(id, keyX[k], keyY[k]);
    }

    /// @dev Impersonates the registry, so a test can reach {retireAllIssuerKeys} without going
    /// through a member removal.
    function _retireAll(bytes32 id) internal {
        vm.prank(address(registry));
        issuerSet.retireAllIssuerKeys(id);
    }

    /// @dev A stand-in Semaphore identity commitment: any nonzero field element is a valid leaf, and
    /// no test here proves membership, so there is no need to derive one from a Baby Jubjub key.
    function _semaphoreCommitmentFor(bytes32 seed) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("semaphore commitment", seed))) % SNARK_SCALAR_FIELD;
    }

    function _governanceSignerFor(bytes32 seed) internal returns (address) {
        return makeAddr(string.concat("governanceSigner-", vm.toString(seed)));
    }

    function _seedCurvePoints() private {
        keyX[0] = KEY_1_X;
        keyY[0] = KEY_1_Y;
        keyX[1] = KEY_2_X;
        keyY[1] = KEY_2_Y;
        keyX[2] = 2_763_488_322_167_937_039_616_325_905_516_046_217_694_264_098_671_987_087_929_565_332_380_420_898_366;
        keyY[2] = 15_305_195_750_036_305_661_220_525_648_961_313_310_481_046_260_814_497_672_243_197_092_298_550_508_693;
        keyX[3] = 12_252_886_604_826_192_316_928_789_929_706_397_349_846_234_911_198_931_249_025_449_955_069_330_867_144;
        keyY[3] = 1_286_140_751_908_834_028_607_023_759_717_162_073_146_610_688_084_909_004_843_365_841_635_476_459_484;
        keyX[4] = 11_480_966_271_046_430_430_613_841_218_147_196_773_252_373_073_876_138_147_006_741_179_837_832_100_836;
        keyY[4] = 15_148_236_048_131_954_717_802_795_400_425_086_368_006_776_860_859_772_698_778_589_175_317_365_693_546;
        keyX[5] = 10_483_991_165_196_995_731_760_716_870_725_509_190_315_033_255_344_071_753_161_464_961_897_900_552_628;
        keyY[5] = 16_822_899_191_463_256_771_813_724_222_715_007_505_997_804_748_105_685_077_895_991_386_716_774_358_231;
        keyX[6] = 20_092_560_661_213_339_045_022_877_747_484_245_238_324_772_779_820_628_739_268_223_482_659_246_842_641;
        keyY[6] = 12_112_450_042_127_193_446_189_577_552_007_703_839_818_242_727_902_437_791_835_414_514_847_797_088_033;
        keyX[7] = 7_582_035_475_627_193_640_797_276_505_418_002_166_691_739_036_475_590_846_121_162_698_650_004_832_581;
        keyY[7] = 7_801_528_930_831_391_612_913_542_953_849_263_092_120_765_287_178_679_640_990_215_688_947_513_841_260;
        keyX[8] = 4_705_897_243_203_718_691_035_604_313_913_899_717_760_209_962_238_015_362_153_877_735_592_901_317_263;
        keyY[8] = 11_533_909_001_000_295_577_818_857_040_682_494_493_436_124_051_895_563_619_976_413_559_559_984_357_704;
        keyX[9] = 153_240_920_024_090_527_149_238_595_127_650_983_736_082_984_617_707_450_012_091_413_752_625_486_998;
        keyY[9] = 4_020_276_081_434_545_615_309_760_015_178_511_782_232_038_136_121_596_626_881_988_383_789_905_359_767;
    }
}
