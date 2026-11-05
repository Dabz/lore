// SPDX-FileCopyrightText: 2026 Epic Games, Inc.
// SPDX-License-Identifier: MIT
import type { Address, Fragment } from "./gen/lore/model/v1/model_pb.js";
import type { PackedMutablePartition } from "./index.js";

export type FragmentAddress = Pick<Address, "hash" | "context">;
export type FragmentHeader = Pick<Fragment, "flags" | "sizePayload" | "sizeContent">;
export type Scope = { id: string; store: DurableObjectStub<PackedMutablePartition> };
export type PackEntry = { hash: string; context: string; key: string; offset: number; length: number; flags: number; content: string };
export type PackLocation = Omit<PackEntry, "hash" | "context">;
export type PackRelocation = { hash: string; old: PackLocation; key: string; offset: number };
export type RepositoryRequest = {
  id: string;
  name: string;
  description: string;
  defaultBranchId: string;
  defaultBranchName: string;
  creator: string;
};
export type RepositoryData = RepositoryRequest & { created: number; metadata: string };
export type BranchData = {
  id: string;
  name: string;
  creator: string;
  category: string;
  created: number;
  latest: string;
  deleted: boolean;
  metadata: string;
  number?: string;
};
