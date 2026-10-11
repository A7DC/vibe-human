import * as THREE from 'three'

/** In-place clips for human5's native deform rig, authored in its +Z-forward space.
 * Most chest, head and facial joints are independent armature children. Moving
 * only DEF-spine therefore tears the face away: we carry every upper-body root
 * through the same hip-pivot transform, preserving all original bind transforms.
 */
export function createGameAnimations(root: THREE.Object3D): THREE.AnimationClip[] {
  const bones = new Map<string, THREE.Bone>()
  root.traverse((object) => { if ((object as THREE.Bone).isBone) bones.set(object.name, object as THREE.Bone) })
  const find = (name: string) => {
    const bone = bones.get(name) ?? bones.get(THREE.PropertyBinding.sanitizeNodeName(name))
    if (!bone) throw new Error(`Game animation requires native human5 joint ${name}`)
    return bone
  }
  const hips = find('DEF-spine')
  const armature = hips.parent
  if (!armature) throw new Error('Native character armature is missing')
  const parts = (side: 'L' | 'R') => ({
    thigh: find(`DEF-thigh.${side}`), shin: find(`DEF-thigh.${side}.001`),
    foot: find(`DEF-foot.${side}`), upper: find(`DEF-upper_arm.${side}`),
    forearm: find(`DEF-forearm.${side}.001`), hand: find(`DEF-hand.${side}`),
    fingers: ['index', 'middle', 'ring', 'pinky'].map(digit =>
      ['01', '02', '03'].map(segment => find(`DEF-f_${digit}.${segment}.${side}`))),
    thumb: ['01', '02', '03'].map(segment => find(`DEF-thumb.${segment}.${side}`)),
  })
  const left = parts('L'), right = parts('R')
  const rest = new Map<THREE.Object3D, { p: THREE.Vector3; q: THREE.Quaternion }>()
  for (const bone of bones.values()) rest.set(bone, { p: bone.position.clone(), q: bone.quaternion.clone() })
  rest.set(armature, { p: armature.position.clone(), q: armature.quaternion.clone() })
  // Work in armature coordinates so wrapper scale and the game's 180° facing
  // correction cannot change the authored motion or knee bend direction.
  const rigQuaternion = (bone: THREE.Object3D): THREE.Quaternion => {
    const q = rest.get(bone)!.q.clone()
    return bone.parent && bone.parent !== armature ? rigQuaternion(bone.parent).multiply(q) : q
  }
  const worldRest = new Map([...bones.values()].map(bone => [bone, rigQuaternion(bone)]))
  const xAxis = new THREE.Vector3(1, 0, 0)
  const yAxis = new THREE.Vector3(0, 1, 0)
  const upperRoots = [...bones.values()].filter(bone => bone.parent === armature
    && bone !== left.thigh && bone !== right.thigh && bone.name !== 'neutral_bone')
  const duration = { idle: 2.4, walk: .96, run: .64, crouch: 1.16, jump: .8 }
  type Mode = keyof typeof duration
  return (Object.keys(duration) as Mode[]).map(mode => {
    const frames = Math.ceil(duration[mode] * 30)
    const times = Array.from({ length: frames + 1 }, (_, i) => i * duration[mode] / frames)
    const values = new Map<string, number[]>()
    const record = (node: THREE.Object3D, property: 'position' | 'quaternion', value: THREE.Vector3 | THREE.Quaternion) => {
      const key = `${node.name}.${property}`
      if (!values.has(key)) values.set(key, [])
      value.toArray(values.get(key)!, values.get(key)!.length)
    }
    for (let frame = 0; frame <= frames; frame++) {
      const phase = frame / frames * Math.PI * 2
      const crouching = mode === 'crouch', running = mode === 'run', airborne = mode === 'jump'
      const moving = mode === 'walk' || running || crouching
      const stride = moving ? (running ? .70 : crouching ? .14 : .40) : 0
      // Idle/jump loops have identical endpoints. Jump is an airborne pose, not
      // a baked takeoff/landing: the game capsule owns those timing events.
      const breathe = Math.sin(phase)
      let lowestAnkleDelta = Infinity
      const lean = crouching ? .72 : running ? .10 : airborne ? .08 : .012 * breathe
      const twist = moving ? .035 * Math.sin(phase) : .008 * breathe
      const torso = new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, twist, moving ? .012 * Math.sin(phase) : 0, 'YXZ'))
      const pivot = rest.get(hips)!.p
      for (const bone of upperRoots) {
        const bind = rest.get(bone)!
        record(bone, 'position', bind.p.clone().sub(pivot).applyQuaternion(torso).add(pivot))
        // Arm rotations are recorded below, after their shoulders are carried
        // with the torso. Avoid two tracks targeting the same property.
        if (bone !== left.upper && bone !== right.upper) record(bone, 'quaternion', torso.clone().multiply(bind.q))
      }
      for (const [part, sign] of [[left, 1], [right, -1]] as const) {
        const swing = Math.sin(phase) * sign
        // Knee recovery occurs while the thigh travels back-to-front;
        // the opposite half-cycle is the planted, extended support leg.
        const recovery = moving ? Math.max(0, Math.cos(phase) * sign) : 0
        const thighAngle = (crouching ? 1.25 : airborne ? .34 : 0) + stride * swing
        const knee = crouching ? 2.06 + .10 * recovery : airborne ? .76 + .08 * breathe
          : .06 + (running ? 1.12 : .57) * recovery * recovery
        const thighQ = new THREE.Quaternion().setFromAxisAngle(xAxis, -thighAngle).multiply(worldRest.get(part.thigh)!)
        const shinQ = new THREE.Quaternion().setFromAxisAngle(xAxis, -(thighAngle - knee)).multiply(worldRest.get(part.shin)!)
        // Keep the support foot close to level; only the recovering toe lifts.
        const footAngle = airborne ? -.18 : crouching ? .04 : -.20 * recovery + .08 * Math.max(0, swing)
        const footQ = new THREE.Quaternion().setFromAxisAngle(xAxis, footAngle).multiply(worldRest.get(part.foot)!)
        const ankle = rest.get(part.shin)!.p.clone().applyQuaternion(thighQ)
          .add(rest.get(part.foot)!.p.clone().applyQuaternion(shinQ))
        const bindAnkle = rest.get(part.shin)!.p.clone().applyQuaternion(worldRest.get(part.thigh)!)
          .add(rest.get(part.foot)!.p.clone().applyQuaternion(worldRest.get(part.shin)!))
        lowestAnkleDelta = Math.min(lowestAnkleDelta, ankle.y - bindAnkle.y)
        record(part.thigh, 'quaternion', thighQ)
        record(part.shin, 'quaternion', thighQ.clone().invert().multiply(shinQ))
        record(part.foot, 'quaternion', shinQ.clone().invert().multiply(footQ))
        const armSwing = moving ? -swing * (running ? .58 : crouching ? .12 : .30) : .015 * breathe * sign
        const armAngle = (crouching ? .27 : airborne ? -.28 : 0) + armSwing
        const elbow = running ? 1.12 : crouching ? .86 : airborne ? .72 : .24 + (moving ? .10 * Math.max(0, -swing) : .018 * breathe)
        const aim = (bone: THREE.Bone, angle: number, out: number) => {
          const bind = worldRest.get(bone)!
          const from = yAxis.clone().applyQuaternion(bind)
          const to = new THREE.Vector3(sign * out, -Math.cos(angle), Math.sin(angle)).normalize()
          return torso.clone().multiply(new THREE.Quaternion().setFromUnitVectors(from, to).multiply(bind))
        }
        const upperQ = aim(part.upper, armAngle, .10)
        const lowerQ = aim(part.forearm, armAngle + elbow, .06)
        record(part.upper, 'quaternion', upperQ)
        record(part.forearm, 'quaternion', upperQ.clone().invert().multiply(lowerQ))
        record(part.hand, 'quaternion', rest.get(part.hand)!.q)
        // Both mirrored native finger chains use +local X for palmar flexion:
        // +Y follows each phalanx and +Z points toward the palm. Apply after
        // each bind quaternion so native joint roll and finger spacing remain.
        // Running uses a loose fist, with no thumb burial or rigid flat palm.
        const grip = running ? 1 : airborne ? .65 : crouching ? .4 : moving ? .32 : .22
        const pulse = .012 * breathe
        for (const [digit, chain] of part.fingers.entries()) {
          const stagger = 1 + digit * .035
          for (const [segment, bone] of chain.entries()) {
            const curl = ([.12, .16, .10][segment] + grip * [.46, .60, .35][segment] + pulse) * stagger
            record(bone, 'quaternion', rest.get(bone)!.q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(xAxis,curl)))
          }
        }
        // The thumb's native roll differs from the four fingers; keep its
        // opposition conservative and bend only enough to rest by the index.
        for (const [segment,bone] of part.thumb.entries()) {
          const curl = [.035,.09,.07][segment] + grip * [.08,.19,.16][segment]
          record(bone,'quaternion',rest.get(bone)!.q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(xAxis,curl)))
        }
      }
      // Vertical compensation keeps the supporting ankle at its bind height;
      // knees shorten the legs naturally in crouch instead of sinking feet
      // through the floor or floating the whole character above it.
      const lift = airborne ? -.055 : -lowestAnkleDelta + (running ? .035 * Math.abs(Math.sin(phase * 2)) : 0)
      record(armature, 'position', rest.get(armature)!.p.clone().add(new THREE.Vector3(0, lift, 0)))
    }
    const tracks = [...values].map(([name, data]) => name.endsWith('.quaternion')
      ? new THREE.QuaternionKeyframeTrack(name, times, data)
      : new THREE.VectorKeyframeTrack(name, times, data))
    return new THREE.AnimationClip(mode, duration[mode], tracks)
  })
}
