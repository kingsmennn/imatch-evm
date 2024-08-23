import { ethers } from "ethers";
import { marketAbi } from "@/blockchain/abi";
import { defineStore } from "pinia";
import {
  AccountType,
  BlockchainUser,
  CreateUserDTO,
  STORE_KEY,
  STORE_KEY_MIDDLEWARE,
  User,
  Location,
  Store,
} from "@/types";
import {
  appMetaData,
  DEBUG,
  HEDERA_JSON_RPC,
  LOCATION_DECIMALS,
  PROJECT_ID,
} from "@/utils/constants";
import { getEvmAddress } from "@/utils/contract-utils";
import { useStoreStore } from "./store";

type UserStore = {
  accountId: string | null;
  provider: any | null;
  signer: ethers.Signer | null;
  userDetails?: BlockchainUser;
  storeDetails?: Store[];
  blockchainError: {
    userNotFound: boolean;
  };
};

export const useUserStore = defineStore(STORE_KEY, {
  state: (): UserStore => ({
    accountId: null,
    provider: null,
    signer: null,
    userDetails: undefined,
    storeDetails: undefined,
    blockchainError: {
      userNotFound: false,
    },
  }),
  getters: {
    isConnected: (state) => !!state.accountId,
    isNotOnboarded: (state) =>
      !!state.accountId && state.blockchainError.userNotFound,
    passedSecondaryCheck: (state) => {
      return state.userDetails?.[5] === AccountType.BUYER
        ? // buyers only need to give access to their location
          !!state.userDetails?.[3][0]
        : // sellers need to set up their store
          !!state?.storeDetails?.[0]?.name;
    },
    username: (state) => state.userDetails?.[1],
    phone: (state) => state.userDetails?.[2],
    location: (state) => state.userDetails?.[3],
    accountType: (state) => state.userDetails?.[5],
  },
  actions: {
    async connectToMetaMask() {
      try {
        if (!window.ethereum) {
          throw new Error("MetaMask is not installed");
        }

        // Request account access if needed
        const accounts = await window.ethereum.request({
          method: "eth_requestAccounts",
        });

        // Create a provider and signer
        this.provider = new ethers.BrowserProvider(window.ethereum);
        this.signer = this.provider.getSigner();

        // Set the account ID (address)
        this.accountId = accounts[0];

        const blockchainUser = await this.fetchUser(this.accountId!);
        this.storeUserDetails(blockchainUser);

        // If the user is a seller, fetch their store details
        if (this.accountType === AccountType.SELLER) {
          const storeStore = useStoreStore();
          const res = await storeStore.getUserStores(this.accountId!);
          this.storeDetails = res || [];
        }
      } catch (error) {
        console.error("Failed to connect to MetaMask:", error);
      }
    },

    async disconnect() {
      this.provider = null;
      this.signer = null;
      this.accountId = null;
      this.userDetails = undefined;
      this.blockchainError.userNotFound = false;
    },

    getContract() {
      const env = useRuntimeConfig().public;

      if (!this.signer) {
        throw new Error(
          "Signer is not available. Please connect to MetaMask first."
        );
      }

      return new ethers.Contract(env.contractId, marketAbi, this.signer);
    },

    async fetchUser(account_id: string): Promise<BlockchainUser> {
      const contract = this.getContract();
      const userAddress = await getEvmAddress(account_id);

      const user = await contract.users(userAddress);
      return user;
    },

    async storeUserDetails(user: BlockchainUser) {
      const userCookie = useCookie<User>(STORE_KEY_MIDDLEWARE);

      const hasId = !!user[0];
      if (hasId) {
        const details = {
          id: Number(user[0]),
          username: user[1],
          phone: user[2],
          location: {
            long: Number(user[3][0]),
            lat: Number(user[3][1]),
          },
          createdAt: Number(user[4]),
          accountType:
            Number(user[5]) === 0 ? AccountType.BUYER : AccountType.SELLER,
        };

        this.userDetails = [
          details.id,
          details.username,
          details.phone,
          [details.location.long, details.location.lat],
          details.createdAt,
          details.accountType,
        ];

        userCookie.value = {
          id: this.accountId!,
          username: details.username,
          phone: details.phone,
          location: [details.location.long, details.location.lat],
          createdAt: new Date(details.createdAt),
          accountType: details.accountType,
        };
      } else if (!hasId && this.accountId) {
        this.blockchainError.userNotFound = true;
      }
    },

    async createUser({
      username,
      phone,
      lat,
      long,
      account_type,
    }: CreateUserDTO): Promise<ethers.ContractTransaction | undefined> {
      if (!this.signer) return;

      try {
        const contract = this.getContract();
        const tx = await contract.createUser(
          username,
          phone,
          ethers.parseUnits(lat.toString(), LOCATION_DECIMALS),
          ethers.parseUnits(long.toString(), LOCATION_DECIMALS),
          account_type === AccountType.BUYER ? 0 : 1
        );

        const receipt = await tx.wait();

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const blockchainUser = await this.fetchUser(this.accountId!);
        this.storeUserDetails(blockchainUser);

        this.blockchainError.userNotFound = false;
        return receipt;
      } catch (error) {
        console.error("Error creating user:", error);
      }
    },

    async updateUser({
      username,
      phone,
      lat,
      long,
      account_type,
    }: Partial<CreateUserDTO>): Promise<
      { receipt: ethers.ContractTransaction; location: Location } | undefined
    > {
      if (!this.signer) return;

      try {
        const contract = this.getContract();
        const tx = await contract.updateUser(
          username || this.userDetails?.[1],
          phone || this.userDetails?.[2],
          ethers.parseUnits(
            (lat || this.userDetails?.[3][1]!).toString(),
            LOCATION_DECIMALS
          ),
          ethers.parseUnits(
            (long || this.userDetails?.[3][0]!).toString(),
            LOCATION_DECIMALS
          ),
          account_type === AccountType.BUYER ? 0 : 1
        );

        const receipt = await tx.wait();
        return {
          receipt,
          location: [
            long || this.userDetails?.[3][0]!,
            lat || this.userDetails?.[3][1]!,
          ],
        };
      } catch (error) {
        console.error("Error updating user:", error);
      }
    },
  },
  persist: {
    paths: [
      "accountId",
      "userDetails",
      "blockchainError.userNotFound",
      "storeDetails.name",
      "storeDetails.description",
      "storeDetails.location",
    ],
    async afterRestore(context) {
      // Reconnect to MetaMask if the user is already connected
      if (context.store.accountId) {
        await context.store.connectToMetaMask();
      }
    },
  },
});
