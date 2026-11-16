import {getAddress,zeroAddress,type Address} from 'viem';

/** Configure the upstream V2 fee switch without silently replacing another treasury. */
export async function configureProtocolFee(options:{
 treasury:Address;admin:Address;readRecipient:()=>Promise<Address>;
 readAdmin:()=>Promise<Address>;setRecipient:(recipient:Address)=>Promise<unknown>;
}){
 const treasury=getAddress(options.treasury);
 if(treasury===zeroAddress)throw new Error('Protocol treasury cannot be zero');
 const current=getAddress(await options.readRecipient());
 if(current===treasury)return;
 if(current!==zeroAddress)throw new Error('Unexpected protocol fee recipient; review before changing it');
 if(getAddress(await options.readAdmin())!==getAddress(options.admin))throw new Error('Wrong fee administrator');
 await options.setRecipient(treasury);
 if(getAddress(await options.readRecipient())!==treasury)throw new Error('Protocol fee recipient was not confirmed');
}
