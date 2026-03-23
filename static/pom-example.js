// Using our zk‑toolbox (https://github.com/prifilabs/zk-toolbox) library a commitment is defined as:
// commitment = Poseidon(secret, nullifier)

import { ProofOfMembership, randomBigInt32ModP, poseidon } from "@prifilabs/zk-toolbox";

// step 1: generate the inputs
let secret, nullifier, commitment;
const commitments = [];
const random = Math.floor(Math.random() * 100);
for (let i =0; i<100; i++){
	const s = randomBigInt32ModP();
	const n = randomBigInt32ModP();
	const c = poseidon([s, n]);
	if (random == i){
		secret = s;
		nullifier = n;
		commitment = c;
	}
	commitments.push(c);
}
const nonce = randomBigInt32ModP();
const privateInputs = { secret };
const publicInputs = { commitments, nullifier, nonce };

// step 2: generate the proof
const proofOfMembership = new ProofOfMembership();
const { proof, publicOutputs } = await proofOfMembership.generate(privateInputs, publicInputs);

// step 3: verify the output (optional) 
console.assert(publicOutputs.authHash == poseidon([privateInputs.secret, publicInputs.nullifier, publicInputs.nonce]));

// step 4: verify the proof
const res = await proofOfMembership.verify(proof, publicInputs, publicOutputs);
console.assert(res);