import { ethers } from 'ethers';
import ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import BIP32Factory from 'bip32';
import { Buffer } from 'buffer';
import * as Segwit from 'segwit';
import { clearAccessTokenStorage } from '@utils/auth';
import { resetUser } from '@redux/user/action';
import store from '@redux';
import { ROUTE_PATH } from '@constants/route-path';
import { getError } from '@utils/text';
import storage from '@utils/storage';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const toXOnly = (pubKey: Buffer) =>
    pubKey.length === 32 ? pubKey : pubKey.slice(1, 33);

const defaultPath = "m/86'/0'/0'/0/0";

// sign message with first sign transaction
const TAPROOT_MESSAGE =
    'Sign this message to generate your Bitcoin Taproot key. This key will be used for your generative.xyz transactions.';

export const genMetamaskMessageForSign = (payload: {
    taprootAddress: string;
    segwitAddress: string;
    nonceMessage: string;
}) => {
    return `GM.\n\nPlease sign this message to confirm your Generative wallet addresses generated by your Ethereum address.\n\nTaproot address:\n${payload.taprootAddress}\n\nSegwit address:\n${payload.segwitAddress}\n\nNonce:\n${payload.nonceMessage}\n\nThe Generative Core Team`;
};

const getBitcoinKeySignContent = (message: string): Buffer => {
    return Buffer.from(message);
};

export const generateBitcoinTaprootKey = async (address: string) => {
    // eslint-disable-next-line no-useless-catch
    try {
        const provider = new ethers.providers.Web3Provider(
            window.ethereum as ethers.providers.ExternalProvider
        );
        const toSign =
            '0x' + getBitcoinKeySignContent(TAPROOT_MESSAGE).toString('hex');
        const signature = await provider.send('personal_sign', [
            toSign,
            address.toString(),
        ]);
        const seed = ethers.utils.arrayify(
            ethers.utils.keccak256(ethers.utils.arrayify(signature))
        );
        const root = bip32.fromSeed(Buffer.from(seed));

        // Taproot
        const taprootChild = root.derivePath(defaultPath);
        const { address: taprootAddress } = bitcoin.payments.p2tr({
            internalPubkey: toXOnly(taprootChild.publicKey),
        });

        if (taprootAddress) {
            storage.setUserTaprootAddress(address, taprootAddress);
        }

        return {
            root,
            taprootChild,
            address: taprootAddress,
            signature,
        };
    } catch (error) {
        const isMetamaskAuthError = await isAuthMetamaskError(error, address);
        if (isMetamaskAuthError && !!store && !!store.dispatch) {
            clearAccessTokenStorage();
            store.dispatch(resetUser());
            window.location.replace(ROUTE_PATH.METAMASK);
        }
        throw error;
    }
};

export const signMetamaskWithMessage = async ({
                                                  address, // metamask address
                                                  taprootAddress,
                                                  segwitAddress,
                                                  nonceMessage,
                                              }: {
    address: string;
    segwitAddress: string;
    taprootAddress: string;
    nonceMessage: string;
}) => {
    const provider = new ethers.providers.Web3Provider(
        window.ethereum as ethers.providers.ExternalProvider
    );

    const SIGN_MESSAGE = genMetamaskMessageForSign({
        taprootAddress,
        nonceMessage: nonceMessage,
        segwitAddress: segwitAddress,
    });

    const toSign = '0x' + getBitcoinKeySignContent(SIGN_MESSAGE).toString('hex');
    const signature = await provider.send('personal_sign', [
        toSign,
        address.toString(),
    ]);

    return signature;
};

const generateBitcoinKey = async ({
                                      address,
                                      message: nonceMessage, // sign message with second sign transaction
                                  }: {
    address: string;
    message: string;
}) => {
    const {
        root,
        address: sendTaprootAddress,
        signature,
    } = await generateBitcoinTaprootKey(address);

    // Segwit
    const signSegwit = await Segwit.signBitcoinSegwitRoot({
        signMessage: nonceMessage,
        root,
    });

    let signatureMetamask = '';
    if (!!sendTaprootAddress && !!signSegwit.address) {
        signatureMetamask = await signMetamaskWithMessage({
            address,
            taprootAddress: sendTaprootAddress,
            segwitAddress: signSegwit.address,
            nonceMessage: nonceMessage,
        });
    }

    return {
        signatureMetamask,

        taproot: {
            sendAddress: sendTaprootAddress,
            signature,
            message: TAPROOT_MESSAGE,
        },

        segwit: {
            sendAddress: signSegwit.address,
            signature: signSegwit.signature,
            message: signSegwit.message,
            messagePrefix: signSegwit.messagePrefix,
            key: signSegwit.privateKey,
        },
    };
};

const isAuthMetamaskError = async (error: unknown, profileAddress: string) => {
    const provider = new ethers.providers.Web3Provider(
        window.ethereum as ethers.providers.ExternalProvider
    );
    let currentAccount;
    const accounts = await provider.send('eth_requestAccounts', []);
    if (!!accounts && !!accounts.length) {
        currentAccount = accounts[0];
        // force re-sign in
        if (!!error && !!currentAccount && currentAccount !== profileAddress) {
            const _err = getError(error);
            return _err.code === 4100;
        }
    }
    return false;
};

export { generateBitcoinKey, getBitcoinKeySignContent, isAuthMetamaskError };