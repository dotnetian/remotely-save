import PQueue from "p-queue";
import XRegExp from "xregexp";
import type {
  ConflictActionType,
  EmptyFolderCleanType,
  Entity,
  MixedEntity,
} from "./baseTypes";
import { isInsideObsFolder } from "./obsFolderLister";
import {
  isSpecialFolderNameToSkip,
  isHiddenPath,
  unixTimeToStr,
  getParentFolder,
  isVaildText,
  atWhichLevel,
  mkdirpInVault,
} from "./misc";
import {
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE,
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2,
} from "./metadataOnRemote";
import {
  MAGIC_ENCRYPTED_PREFIX_BASE32,
  MAGIC_ENCRYPTED_PREFIX_BASE64URL,
  decryptBase32ToString,
  decryptBase64urlToString,
  encryptStringToBase64url,
  getSizeFromOrigToEnc,
} from "./encrypt";
import { RemoteClient } from "./remote";
import { Vault } from "obsidian";

import { log } from "./moreOnLog";
import AggregateError from "aggregate-error";
import {
  InternalDBs,
  clearPrevSyncRecordByVault,
  upsertPrevSyncRecordByVault,
} from "./localdb";

export type SyncStatusType =
  | "idle"
  | "preparing"
  | "getting_remote_files_list"
  | "getting_local_meta"
  | "getting_local_prev_sync"
  | "checking_password"
  | "generating_plan"
  | "syncing"
  | "cleaning"
  | "finish";

export interface PasswordCheckType {
  ok: boolean;
  reason:
    | "ok"
    | "empty_remote"
    | "remote_encrypted_local_no_password"
    | "password_matched"
    | "password_not_matched"
    | "invalid_text_after_decryption"
    | "remote_not_encrypted_local_has_password"
    | "no_password_both_sides";
}

export const isPasswordOk = async (
  remote: Entity[],
  password: string = ""
): Promise<PasswordCheckType> => {
  if (remote === undefined || remote.length === 0) {
    // remote empty
    return {
      ok: true,
      reason: "empty_remote",
    };
  }
  const santyCheckKey = remote[0].key;
  if (santyCheckKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE32)) {
    // this is encrypted using old base32!
    // try to decrypt it using the provided password.
    if (password === "") {
      return {
        ok: false,
        reason: "remote_encrypted_local_no_password",
      };
    }
    try {
      const res = await decryptBase32ToString(santyCheckKey, password);

      // additional test
      // because iOS Safari bypasses decryption with wrong password!
      if (isVaildText(res)) {
        return {
          ok: true,
          reason: "password_matched",
        };
      } else {
        return {
          ok: false,
          reason: "invalid_text_after_decryption",
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "password_not_matched",
      };
    }
  }
  if (santyCheckKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)) {
    // this is encrypted using new base64url!
    // try to decrypt it using the provided password.
    if (password === "") {
      return {
        ok: false,
        reason: "remote_encrypted_local_no_password",
      };
    }
    try {
      const res = await decryptBase64urlToString(santyCheckKey, password);

      // additional test
      // because iOS Safari bypasses decryption with wrong password!
      if (isVaildText(res)) {
        return {
          ok: true,
          reason: "password_matched",
        };
      } else {
        return {
          ok: false,
          reason: "invalid_text_after_decryption",
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "password_not_matched",
      };
    }
  } else {
    // it is not encrypted!
    if (password !== "") {
      return {
        ok: false,
        reason: "remote_not_encrypted_local_has_password",
      };
    }
    return {
      ok: true,
      reason: "no_password_both_sides",
    };
  }
};

const isSkipItemByName = (
  key: string,
  syncConfigDir: boolean,
  syncUnderscoreItems: boolean,
  configDir: string,
  ignorePaths: string[]
) => {
  if (ignorePaths !== undefined && ignorePaths.length > 0) {
    for (const r of ignorePaths) {
      if (XRegExp(r, "A").test(key)) {
        return true;
      }
    }
  }
  if (syncConfigDir && isInsideObsFolder(key, configDir)) {
    return false;
  }
  if (isSpecialFolderNameToSkip(key, [])) {
    // some special dirs and files are always skipped
    return true;
  }
  return (
    isHiddenPath(key, true, false) ||
    (!syncUnderscoreItems && isHiddenPath(key, false, true)) ||
    key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE ||
    key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2
  );
};

const copyEntityAndFixTimeFormat = (src: Entity) => {
  const result = Object.assign({}, src);
  if (result.mtimeCli !== undefined) {
    if (result.mtimeCli === 0) {
      result.mtimeCli = undefined;
    } else {
      result.mtimeCliFmt = unixTimeToStr(result.mtimeCli);
    }
  }
  if (result.mtimeSvr !== undefined) {
    if (result.mtimeSvr === 0) {
      result.mtimeSvr = undefined;
    } else {
      result.mtimeSvrFmt = unixTimeToStr(result.mtimeSvr);
    }
  }
  if (result.prevSyncTime !== undefined) {
    if (result.prevSyncTime === 0) {
      result.prevSyncTime = undefined;
    } else {
      result.prevSyncTimeFmt = unixTimeToStr(result.prevSyncTime);
    }
  }

  return result;
};

/**
 * Inplace, no copy again.
 * @param remote
 * @param password
 * @returns
 */
const decryptRemoteEntityInplace = async (remote: Entity, password: string) => {
  if (password == undefined || password === "") {
    remote.key = remote.keyEnc;
    remote.size = remote.sizeEnc;
    return remote;
  }

  if (remote.keyEnc.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE32)) {
    remote.key = await decryptBase32ToString(remote.keyEnc, password);
  } else if (remote.keyEnc.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)) {
    remote.key = await decryptBase64urlToString(remote.keyEnc, password);
  } else {
    throw Error(`unexpected key to decrypt=${remote.keyEnc}`);
  }

  // TODO
  // remote.size = getSizeFromEncToOrig(remote.sizeEnc, password);
  // but we don't have deterministic way to get a number because the encryption has padding...

  return remote;
};

/**
 * Directly throw error here.
 * We can only defer the checking now, because before decryption we don't know whether it's a file or folder.
 * @param remote
 */
const ensureMTimeOfRemoteEntityValid = (remote: Entity) => {
  if (
    !remote.key.endsWith("/") &&
    remote.mtimeCli === undefined &&
    remote.mtimeSvr === undefined
  ) {
    if (remote.key === remote.keyEnc) {
      throw Error(
        `Your remote file ${remote.key} has last modified time 0, don't know how to deal with it.`
      );
    } else {
      throw Error(
        `Your remote file ${remote.key} (encrypted as ${remote.keyEnc}) has last modified time 0, don't know how to deal with it.`
      );
    }
  }
  return remote;
};

/**
 * Inplace, no copy again.
 * @param local
 * @param password
 * @returns
 */
const encryptLocalEntityInplace = async (
  local: Entity,
  password: string,
  remoteKeyEnc: string | undefined
) => {
  if (password == undefined || password === "") {
    return local;
  }
  if (local.size === local.sizeEnc) {
    local.sizeEnc = getSizeFromOrigToEnc(local.size);
  }
  if (local.key === local.keyEnc) {
    if (
      remoteKeyEnc !== undefined &&
      remoteKeyEnc !== "" &&
      remoteKeyEnc !== local.key
    ) {
      // we can reuse remote encrypted key if any
      local.keyEnc = remoteKeyEnc;
    } else {
      // we assign a new encrypted key because of no remote
      // the old version uses base32
      // local.keyEnc = await encryptStringToBase32(local.key, password);
      // the new version users base64url
      local.keyEnc = await encryptStringToBase64url(local.key, password);
    }
  }
  return local;
};

export type SyncPlanType = Record<string, MixedEntity>;

export const ensembleMixedEnties = async (
  localEntityList: Entity[],
  prevSyncEntityList: Entity[],
  remoteEntityList: Entity[],

  syncConfigDir: boolean,
  configDir: string,
  syncUnderscoreItems: boolean,
  ignorePaths: string[],
  password: string
): Promise<SyncPlanType> => {
  const finalMappings: SyncPlanType = {};

  // remote has to be first
  for (const remote of remoteEntityList) {
    const remoteCopied = ensureMTimeOfRemoteEntityValid(
      await decryptRemoteEntityInplace(
        copyEntityAndFixTimeFormat(remote),
        password
      )
    );

    const key = remoteCopied.key;
    if (
      isSkipItemByName(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        configDir,
        ignorePaths
      )
    ) {
      continue;
    }

    finalMappings[key] = {
      key: key,
      remote: remoteCopied,
    };
  }

  for (const prevSync of prevSyncEntityList) {
    const key = prevSync.key;
    if (
      isSkipItemByName(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        configDir,
        ignorePaths
      )
    ) {
      continue;
    }

    if (finalMappings.hasOwnProperty(key)) {
      const prevSyncCopied = await encryptLocalEntityInplace(
        copyEntityAndFixTimeFormat(prevSync),
        password,
        finalMappings[key].remote?.keyEnc
      );
      finalMappings[key].prevSync = prevSyncCopied;
    } else {
      const prevSyncCopied = await encryptLocalEntityInplace(
        copyEntityAndFixTimeFormat(prevSync),
        password,
        undefined
      );
      finalMappings[key] = {
        key: key,
        prevSync: prevSyncCopied,
      };
    }
  }

  // local has to be last
  // because we want to get keyEnc based on the remote
  // (we don't consume prevSync here because it gains no benefit)
  for (const local of localEntityList) {
    const key = local.key;
    if (
      isSkipItemByName(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        configDir,
        ignorePaths
      )
    ) {
      continue;
    }

    if (finalMappings.hasOwnProperty(key)) {
      const localCopied = await encryptLocalEntityInplace(
        copyEntityAndFixTimeFormat(local),
        password,
        finalMappings[key].remote?.keyEnc
      );
      finalMappings[key].local = localCopied;
    } else {
      const localCopied = await encryptLocalEntityInplace(
        copyEntityAndFixTimeFormat(local),
        password,
        undefined
      );
      finalMappings[key] = {
        key: key,
        local: localCopied,
      };
    }
  }

  return finalMappings;
};

/**
 * Heavy lifting.
 * Basically follow the sync algorithm of https://github.com/Jwink3101/syncrclone
 * @param mixedEntityMappings
 */
export const getSyncPlanInplace = async (
  mixedEntityMappings: Record<string, MixedEntity>,
  howToCleanEmptyFolder: EmptyFolderCleanType,
  skipSizeLargerThan: number,
  conflictAction: ConflictActionType
) => {
  // from long(deep) to short(shadow)
  const sortedKeys = Object.keys(mixedEntityMappings).sort(
    (k1, k2) => k2.length - k1.length
  );

  const keptFolder = new Set<string>();

  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i];
    const mixedEntry = mixedEntityMappings[key];
    const { local, prevSync, remote } = mixedEntry;

    if (key.endsWith("/")) {
      // folder
      // folder doesn't worry about mtime and size, only check their existences
      if (keptFolder.has(key)) {
        // should fill the missing part
        if (local !== undefined && remote !== undefined) {
          mixedEntry.decisionBranch = 101;
          mixedEntry.decision = "folder_existed_both";
        } else if (local !== undefined && remote === undefined) {
          mixedEntry.decisionBranch = 102;
          mixedEntry.decision = "folder_existed_local";
        } else if (local === undefined && remote !== undefined) {
          mixedEntry.decisionBranch = 103;
          mixedEntry.decision = "folder_existed_remote";
        } else {
          mixedEntry.decisionBranch = 104;
          mixedEntry.decision = "folder_to_be_created";
        }
        keptFolder.delete(key); // no need to save it in the Set later
      } else {
        if (howToCleanEmptyFolder === "skip") {
          mixedEntry.decisionBranch = 105;
          mixedEntry.decision = "folder_to_skip";
        } else if (howToCleanEmptyFolder === "clean_both") {
          mixedEntry.decisionBranch = 106;
          mixedEntry.decision = "folder_to_be_deleted";
        } else {
          throw Error(
            `do not know how to deal with empty folder ${mixedEntry.key}`
          );
        }
      }
    } else {
      // file

      if (local === undefined && remote === undefined) {
        // both deleted, only in history
        mixedEntry.decisionBranch = 1;
        mixedEntry.decision = "only_history";
      } else if (local !== undefined && remote !== undefined) {
        if (
          (local.mtimeCli === remote.mtimeCli ||
            local.mtimeCli === remote.mtimeSvr) &&
          local.sizeEnc === remote.sizeEnc
        ) {
          // completely equal / identical
          mixedEntry.decisionBranch = 2;
          mixedEntry.decision = "equal";
          keptFolder.add(getParentFolder(key));
        } else {
          // Both exists, but modified or conflict
          // Look for past files of A or B.

          const localEqualPrevSync =
            prevSync?.mtimeSvr === local.mtimeCli &&
            prevSync?.sizeEnc === local.sizeEnc;
          const remoteEqualPrevSync =
            (prevSync?.mtimeSvr === remote.mtimeCli ||
              prevSync?.mtimeSvr === remote.mtimeSvr) &&
            prevSync?.sizeEnc === remote.sizeEnc;

          if (localEqualPrevSync && !remoteEqualPrevSync) {
            // If only one compares true (no prev also means it compares False), the other is modified. Backup and sync.
            if (
              skipSizeLargerThan <= 0 ||
              remote.sizeEnc <= skipSizeLargerThan
            ) {
              mixedEntry.decisionBranch = 9;
              mixedEntry.decision = "modified_remote";
              keptFolder.add(getParentFolder(key));
            } else {
              throw Error(
                `remote is modified (branch 9) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                  mixedEntry
                )}`
              );
            }
          } else if (!localEqualPrevSync && remoteEqualPrevSync) {
            // If only one compares true (no prev also means it compares False), the other is modified. Backup and sync.
            if (
              skipSizeLargerThan <= 0 ||
              local.sizeEnc <= skipSizeLargerThan
            ) {
              mixedEntry.decisionBranch = 10;
              mixedEntry.decision = "modified_local";
              keptFolder.add(getParentFolder(key));
            } else {
              throw Error(
                `local is modified (branch 10) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                  mixedEntry
                )}`
              );
            }
          } else if (!localEqualPrevSync && !remoteEqualPrevSync) {
            // If both compare False, (didn't exist means both are new. Both exist but don't compare means both are modified)
            if (prevSync === undefined) {
              if (conflictAction === "keep_newer") {
                if (
                  (local.mtimeCli ?? local.mtimeSvr ?? 0) >=
                  (remote.mtimeCli ?? remote.mtimeSvr ?? 0)
                ) {
                  mixedEntry.decisionBranch = 11;
                  mixedEntry.decision = "conflict_created_keep_local";
                  keptFolder.add(getParentFolder(key));
                } else {
                  mixedEntry.decisionBranch = 12;
                  mixedEntry.decision = "conflict_created_keep_remote";
                  keptFolder.add(getParentFolder(key));
                }
              } else if (conflictAction === "keep_larger") {
                if (local.sizeEnc >= remote.sizeEnc) {
                  mixedEntry.decisionBranch = 13;
                  mixedEntry.decision = "conflict_created_keep_local";
                  keptFolder.add(getParentFolder(key));
                } else {
                  mixedEntry.decisionBranch = 14;
                  mixedEntry.decision = "conflict_created_keep_remote";
                  keptFolder.add(getParentFolder(key));
                }
              } else {
                mixedEntry.decisionBranch = 15;
                mixedEntry.decision = "conflict_created_keep_both";
                keptFolder.add(getParentFolder(key));
              }
            } else {
              if (conflictAction === "keep_newer") {
                if (
                  (local.mtimeCli ?? local.mtimeSvr ?? 0) >=
                  (remote.mtimeCli ?? remote.mtimeSvr ?? 0)
                ) {
                  mixedEntry.decisionBranch = 16;
                  mixedEntry.decision = "conflict_modified_keep_local";
                  keptFolder.add(getParentFolder(key));
                } else {
                  mixedEntry.decisionBranch = 17;
                  mixedEntry.decision = "conflict_modified_keep_remote";
                  keptFolder.add(getParentFolder(key));
                }
              } else if (conflictAction === "keep_larger") {
                if (local.sizeEnc >= remote.sizeEnc) {
                  mixedEntry.decisionBranch = 18;
                  mixedEntry.decision = "conflict_modified_keep_local";
                  keptFolder.add(getParentFolder(key));
                } else {
                  mixedEntry.decisionBranch = 19;
                  mixedEntry.decision = "conflict_modified_keep_remote";
                  keptFolder.add(getParentFolder(key));
                }
              } else {
                mixedEntry.decisionBranch = 20;
                mixedEntry.decision = "conflict_modified_keep_both";
                keptFolder.add(getParentFolder(key));
              }
            }
          } else {
            // Both compare true -- This is VERY odd and should not happen
            throw Error(
              `should not reach branch -2 while getting sync plan: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        }
      } else if (local === undefined && remote !== undefined) {
        // A is missing
        if (prevSync === undefined) {
          // if B is not in the previous list, B is new
          if (skipSizeLargerThan <= 0 || remote.sizeEnc <= skipSizeLargerThan) {
            mixedEntry.decisionBranch = 3;
            mixedEntry.decision = "created_remote";
            keptFolder.add(getParentFolder(key));
          } else {
            throw Error(
              `remote is created (branch 3) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        } else if (
          (prevSync.mtimeSvr === remote.mtimeCli ||
            prevSync.mtimeSvr === remote.mtimeSvr) &&
          prevSync.sizeEnc === remote.sizeEnc
        ) {
          // if B is in the previous list and UNMODIFIED, B has been deleted by A
          mixedEntry.decisionBranch = 4;
          mixedEntry.decision = "deleted_local";
        } else {
          // if B is in the previous list and MODIFIED, B has been deleted by A but modified by B
          if (skipSizeLargerThan <= 0 || remote.sizeEnc <= skipSizeLargerThan) {
            mixedEntry.decisionBranch = 5;
            mixedEntry.decision = "modified_remote";
            keptFolder.add(getParentFolder(key));
          } else {
            throw Error(
              `remote is modified (branch 5) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        }
      } else if (local !== undefined && remote === undefined) {
        // B is missing

        if (prevSync === undefined) {
          // if A is not in the previous list, A is new
          if (skipSizeLargerThan <= 0 || local.sizeEnc <= skipSizeLargerThan) {
            mixedEntry.decisionBranch = 6;
            mixedEntry.decision = "created_local";
            keptFolder.add(getParentFolder(key));
          } else {
            throw Error(
              `local is created (branch 6) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        } else if (
          prevSync.mtimeSvr === local.mtimeCli &&
          prevSync.sizeEnc === local.sizeEnc
        ) {
          // if A is in the previous list and UNMODIFIED, A has been deleted by B
          mixedEntry.decisionBranch = 7;
          mixedEntry.decision = "deleted_remote";
        } else {
          // if A is in the previous list and MODIFIED, A has been deleted by B but modified by A
          if (skipSizeLargerThan <= 0 || local.sizeEnc <= skipSizeLargerThan) {
            mixedEntry.decisionBranch = 8;
            mixedEntry.decision = "modified_local";
            keptFolder.add(getParentFolder(key));
          } else {
            throw Error(
              `local is modified (branch 8) but size larger than ${skipSizeLargerThan}, don't know what to do: ${JSON.stringify(
                mixedEntry
              )}`
            );
          }
        }
      } else {
        throw Error(
          `should not reach branch -1 while getting sync plan: ${JSON.stringify(
            mixedEntry
          )}`
        );
      }

      if (mixedEntry.decision === undefined) {
        throw Error(
          `unexpectedly no decision of file in the end: ${JSON.stringify(
            mixedEntry
          )}`
        );
      }
    }
  }

  keptFolder.delete("/");
  keptFolder.delete("");
  if (keptFolder.size > 0) {
    throw Error(`unexpectedly keptFolder no decisions: ${[...keptFolder]}`);
  }

  return mixedEntityMappings;
};

const splitThreeStepsOnEntityMappings = (
  mixedEntityMappings: Record<string, MixedEntity>
) => {
  const folderCreationOps: MixedEntity[][] = [];
  const deletionOps: MixedEntity[][] = [];
  const uploadDownloads: MixedEntity[][] = [];

  // from long(deep) to short(shadow)
  const sortedKeys = Object.keys(mixedEntityMappings).sort(
    (k1, k2) => k2.length - k1.length
  );

  let realTotalCount = 0;

  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i];
    const val = mixedEntityMappings[key];

    if (
      val.decision === "equal" ||
      val.decision === "folder_existed_both" ||
      val.decision === "folder_to_skip"
    ) {
      // pass
    } else if (
      val.decision === "folder_existed_local" ||
      val.decision === "folder_existed_remote" ||
      val.decision === "folder_to_be_created"
    ) {
      const level = atWhichLevel(key);
      if (folderCreationOps[level - 1] === undefined) {
        folderCreationOps[level - 1] = [val];
      } else {
        folderCreationOps[level - 1].push(val);
      }
      realTotalCount += 1;
    } else if (
      val.decision === "only_history" ||
      val.decision === "deleted_local" ||
      val.decision === "deleted_remote" ||
      val.decision === "folder_to_be_deleted"
    ) {
      const level = atWhichLevel(key);
      if (deletionOps[level - 1] === undefined) {
        deletionOps[level - 1] = [val];
      } else {
        deletionOps[level - 1].push(val);
      }
      realTotalCount += 1;
    } else if (
      val.decision === "modified_local" ||
      val.decision === "modified_remote" ||
      val.decision === "created_local" ||
      val.decision === "created_remote" ||
      val.decision === "conflict_created_keep_local" ||
      val.decision === "conflict_created_keep_remote" ||
      val.decision === "conflict_created_keep_both" ||
      val.decision === "conflict_modified_keep_local" ||
      val.decision === "conflict_modified_keep_remote" ||
      val.decision === "conflict_modified_keep_both"
    ) {
      if (uploadDownloads.length === 0) {
        uploadDownloads[0] = [val];
      } else {
        uploadDownloads[0].push(val); // only one level needed here
      }
      realTotalCount += 1;
    } else {
      throw Error(`unknown decision ${val.decision} for ${key}`);
    }
  }

  // the deletionOps should be run from max level to min level
  // right now it is sorted by level from min to max (NOT length of key!)
  // so we need to reverse it!
  deletionOps.reverse(); // inplace reverse

  return {
    folderCreationOps: folderCreationOps,
    deletionOps: deletionOps,
    uploadDownloads: uploadDownloads,
    realTotalCount: realTotalCount,
  };
};

const dispatchOperationToActualV3 = async (
  key: string,
  vaultRandomID: string,
  r: MixedEntity,
  client: RemoteClient,
  db: InternalDBs,
  vault: Vault,
  localDeleteFunc: any,
  password: string
) => {
  if (r.decision === "only_history") {
    clearPrevSyncRecordByVault(db, vaultRandomID, key);
  } else if (
    r.decision === "equal" ||
    r.decision === "folder_to_skip" ||
    r.decision === "folder_existed_both"
  ) {
    // pass
  } else if (
    r.decision === "modified_local" ||
    r.decision === "created_local" ||
    r.decision === "folder_existed_local" ||
    r.decision === "conflict_created_keep_local" ||
    r.decision === "conflict_modified_keep_local"
  ) {
    if (
      client.serviceType === "onedrive" &&
      r.local!.size === 0 &&
      password === ""
    ) {
      // special treatment for empty files for OneDrive
      // TODO: it's ugly, any other way?
      // special treatment for OneDrive: do nothing, skip empty file without encryption
      // if it's empty folder, or it's encrypted file/folder, it continues to be uploaded.
    } else {
      const remoteObjMeta = await client.uploadToRemote(
        r.key,
        vault,
        false,
        password,
        r.local!.keyEnc
      );
      await upsertPrevSyncRecordByVault(db, vaultRandomID, remoteObjMeta);
    }
  } else if (
    r.decision === "modified_remote" ||
    r.decision === "created_remote" ||
    r.decision === "conflict_created_keep_remote" ||
    r.decision === "conflict_modified_keep_remote" ||
    r.decision === "folder_existed_remote"
  ) {
    await mkdirpInVault(r.key, vault);
    await client.downloadFromRemote(
      r.key,
      vault,
      r.remote!.mtimeCli!,
      password,
      r.remote!.keyEnc
    );
    await upsertPrevSyncRecordByVault(db, vaultRandomID, r.remote!);
  } else if (r.decision === "deleted_local") {
    await localDeleteFunc(r.key);
    await clearPrevSyncRecordByVault(db, vaultRandomID, r.key);
  } else if (r.decision === "deleted_remote") {
    await client.deleteFromRemote(r.key, password, r.remote!.keyEnc);
    await clearPrevSyncRecordByVault(db, vaultRandomID, r.key);
  } else if (
    r.decision === "conflict_created_keep_both" ||
    r.decision === "conflict_modified_keep_both"
  ) {
    throw Error(`${r.decision} not implemented yet: ${JSON.stringify(r)}`);
  } else if (r.decision === "folder_to_be_created") {
    await mkdirpInVault(r.key, vault);
    const remoteObjMeta = await client.uploadToRemote(
      r.key,
      vault,
      false,
      password,
      r.local!.keyEnc
    );
    await upsertPrevSyncRecordByVault(db, vaultRandomID, remoteObjMeta);
  } else if (r.decision === "folder_to_be_deleted") {
    await localDeleteFunc(r.key);
    await client.deleteFromRemote(r.key, password, r.remote!.keyEnc);
    await clearPrevSyncRecordByVault(db, vaultRandomID, r.key);
  } else {
    throw Error(`don't know how to dispatch decision: ${JSON.stringify(r)}`);
  }
};

export const doActualSync = async (
  mixedEntityMappings: Record<string, MixedEntity>,
  client: RemoteClient,
  vaultRandomID: string,
  vault: Vault,
  password: string,
  concurrency: number,
  localDeleteFunc: any,
  callbackSyncProcess: any,
  db: InternalDBs
) => {
  log.debug(`concurrency === ${concurrency}`);
  const { folderCreationOps, deletionOps, uploadDownloads, realTotalCount } =
    splitThreeStepsOnEntityMappings(mixedEntityMappings);
  const nested = [folderCreationOps, deletionOps, uploadDownloads];
  const logTexts = [
    `1. create all folders from shadowest to deepest, also check undefined decision`,
    `2. delete files and folders from deepest to shadowest`,
    `3. upload or download files in parallel, with the desired concurrency=${concurrency}`,
  ];

  let realCounter = 0;
  for (let i = 0; i < nested.length; ++i) {
    log.debug(logTexts[i]);

    const operations = nested[i];

    for (let j = 0; j < operations.length; ++j) {
      const singleLevelOps = operations[j];

      const queue = new PQueue({ concurrency: concurrency, autoStart: true });
      const potentialErrors: Error[] = [];
      let tooManyErrors = false;

      for (let k = 0; k < singleLevelOps.length; ++k) {
        const val = singleLevelOps[k];
        const key = val.key;

        const fn = async () => {
          log.debug(`start syncing "${key}" with plan ${JSON.stringify(val)}`);

          if (callbackSyncProcess !== undefined) {
            await callbackSyncProcess(
              realCounter,
              realTotalCount,
              key,
              val.decision
            );

            realCounter += 1;
          }

          await dispatchOperationToActualV3(
            key,
            vaultRandomID,
            val,
            client,
            db,
            vault,
            localDeleteFunc,
            password
          );

          log.debug(`finished ${key}`);
        };

        queue.add(fn).catch((e) => {
          const msg = `${key}: ${e.message}`;
          potentialErrors.push(new Error(msg));
          if (potentialErrors.length >= 3) {
            tooManyErrors = true;
            queue.pause();
            queue.clear();
          }
        });
      }

      await queue.onIdle();

      if (potentialErrors.length > 0) {
        if (tooManyErrors) {
          potentialErrors.push(
            new Error("too many errors, stop the remaining tasks")
          );
        }
        throw new AggregateError(potentialErrors);
      }
    }
  }
};
