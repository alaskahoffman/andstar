// Default editor content: a short scene that demonstrates every DSL feature.

export const SAMPLE_GAME = `# ============================================================
#  DEAD RECKONING, a sample game
#  The night mail goes down in the desert, 1935.
#  Lines starting with # are comments.
# ============================================================

@title Dead Reckoning
@author Fable

# Players distribute 4 extra points before the game starts (max 6 per skill).
@points 4 max 6

# --- fail state --------------------------------------------------
# When this becomes true the run fails and the player returns to the
# last ~ save checkpoint. A choice can also fail directly with: -> FAIL
@fail resolve <= 0 "The sand is soft as snow, and warm. You lie down in it the way men lie down in snow."

# --- looks (optional) --------------------------------------------
# Uncomment to restyle the player. Shades are derived from @bg.
# @bg #10141d
# @accent #c8a96a
# @font serif      # book (default), mono, serif, sans, humanist
# @reveal paced   # line pacing: click (default), paced, off

# --- skills: id "Name" #color = starting value -------------------
# Skills can SPEAK in dialogue, gate passive interjections,
# and be rolled in white/red checks.

skill hands     "The Hands"   #d98b6a = 3
skill reckoning "Reckoning"   #6cb9ff = 3
skill sangfroid "Sang-Froid"  #8fb3a8 = 2
skill senses    "The Senses"  #a8c97f = 3
skill heart     "The Heart"   #c79ddb = 2

# --- characters ---------------------------------------------------

char marchand "Marchand" #f0c987

# --- items ---------------------------------------------------------
# Items with skill modifiers are equipment. Players can equip and
# unequip them whenever the wardrobe is open. Items WITHOUT modifiers
# are plain possessions: no equip box, but has(item) still works.

item jacket "Flying Jacket"  sangfroid+1 hands-1
item torch  "Electric Torch" senses+2
item scarf  "Silk Scarf"     heart+1
item orange "One Orange"
item chart  "Soaked Chart"

# --- currency & state ----------------------------------------------
# Currency doesn't have to be money. Out here it is water.

currency water "Water (cups)" = 0
stat resolve = 3
var knows_drift = false

# ===================================================================
#  PASSAGES. The first one is where the game starts.
# ===================================================================

== start
Four hours out, southbound with the mail in the dark. The moon went down behind you like a coal sinking in water, and now the cloud has closed beneath the plane like a second sea.
~ give jacket
~ equip jacket
~ give torch
~ give scarf
~ give orange
~ wardrobe open
marchand: He leans forward from the dark behind you and shouts over the engine: "Cigarette?" He is not afraid. He has decided not to be.
? senses 6: The exhaust flame is running long and orange. Headwind, or tailwind. The engine knows something about the air that the charts do not.
Your gear is in the sidebar. What you carry on your body changes what you can do.
* Climb, and look for a star to steer by -> climb
* Hold low, under the cloud, and trust the sand to stay where it was -> low
* [white reckoning 10] Run the dead reckoning again, wind and hours and drift, in your head -> drift_yes | drift_no

== climb
You climb. The cloud climbs with you, patient as water filling a glass. At three thousand meters there is still no star. Only the cabin lamp, and Marchand's lighter flaring behind you like a small domestic sun.
-> descent

== low
You let her sink toward where the desert ought to be. The altimeter unwinds slowly, confiding, like a man telling you a secret he does not understand.
-> descent

== drift_yes
~ set knows_drift = true
~ points 1
The numbers assemble themselves and stand at attention. The wind has been lying to you for three hours: you are far south of the line, and lower than the air admits.
reckoning: The desert here is not at sea level. The desert here is a plateau. Subtract it from the altimeter and what remains is very little.
-> descent

== drift_no
The numbers will not hold still. Three hours of wind, the fuel burned, the compass swinging its small magnetic shrug. It all dissolves like sugar.
reckoning: Somewhere in this arithmetic is the ground. You cannot find it.
-> descent

== descent
The cloud thins, and through it comes not light but a deeper black: no lamps, no wells, no caravans. A country with nobody in it.
~ wardrobe close
~ save
sangfroid: Hands at altitude one thousand. Whatever happens now, happens slowly in the mind and fast in the world.
[knows_drift] reckoning: You are lower than the dial says. The plateau is rising under you RIGHT NOW.
* [knows_drift] Pull up, count three, then ease her down blind, flat as a prayer -> wreck
* [red hands 12] Feel for the ground. Fly her into it like a landing. -> wreck | wreck_hurt
* Cut the throttle, cover your face, and let her arrive -> wreck_hurt

== wreck_hurt
The world hits twice. The second time it takes something with it. When the noise stops you are tasting copper, and one rib moves in a way ribs should not.
~ set resolve = resolve - 1
~ skill sangfroid -1
-> wreck

== wreck
[once] ~ wardrobe open
[once] Silence, enormous and sudden, with one small sound inside it: somewhere in the wreck, a wire ticking as it cools. You are alive. The plane skidded two hundred meters on her belly and is now a shape that will never fly anywhere again.
[once] marchand: A scrabbling, a cough, and then Marchand's voice, furious with relief: "I'm not dead. That's something. That's the main thing."
The desert at night is black sand under black sky, with a line of stars where they meet. Cold comes up out of the ground like a tide.
? senses 7: Petrol, but faint, and fading. She didn't burn. Whatever is in the tanks and the thermos is still yours.
* [once] Go through the wreck by feel, pocket by pocket, locker by locker -> salvage
* [white senses 9] Quarter the ground around the wreck with the torch -> found_chart | found_nothing
* [pay 1] Drink. One cup. Make it last a hundred small swallows. -> drink_night
* [once] Sit with Marchand against the warm side of the engine -> marchand_talk
* Walk out now, into the dark, while the walking is cool -> night_walk
* Wait for dawn -> dawn

== salvage
~ earn 2
The thermos lives. Two cups of coffee gone lukewarm, which out here is treasure. Also: a handful of grapes gone to raisins in their bag, and the first-aid kit, crushed flat.
sangfroid: Two cups. Say it plainly and do not say it again.
-> wreck

== found_chart
~ give chart
The torch finds paper flapping against a thorn bush twenty meters out: your chart, thrown clear, soaked in something. Oil, dew, no matter. One corner is still legible. One corner may be enough.
-> wreck

== found_nothing
Stones, thorns, the long scar the plane plowed. The torchlight makes every pebble cast a shadow like a mountain at sunset.
senses: Nothing out here but geology and you.
-> wreck

== drink_night
The coffee is cold and tastes faintly of the thermos cork, and it is the finest thing you have ever drunk.
~ set resolve = resolve + 1
-> wreck

== marchand_talk
marchand: "I knew a man," Marchand says, to the engine, to the dark, "who walked out of the deep desert once. Eight days." A pause. "He was an idiot, that one. You're not."
heart: He is building you a rope out of nothing, and handing you one end of it.
~ set resolve = resolve + 1
~ points 1
-> wreck

== night_walk
You walk. Within twenty steps the wreck has vanished behind you; within a hundred, every direction is the same direction.
* [red sangfroid 11] Hold a star on your shoulder and your panic at arm's length -> circled | oh_no
* Keep walking. Any direction is a decision. -> oh_no

== circled
The star holds you on a long leash and walks you in a circle, and that circle saves your life: a black shape rises out of the sand ahead, and it is your own dead airplane.
sangfroid: Sit down. The desert is bigger at night. Everything is.
~ set resolve = resolve - 1
-> wreck

== oh_no
The night closes over your tracks behind you, quietly, the way water does.
-> FAIL

== dawn
Dawn comes the color of iron, then of fire. The country shows itself at last: a plateau of black pebbles to every horizon, perfectly clean, perfectly empty, like the floor of a sea that gave up the sea.
[once] marchand: Marchand stands very still, looking at all of it. "Right," he says finally, as if agreeing to terms.
? senses 8: There, on the wing fabric: a grey sheen. Dew. The desert sweats at dawn, for an hour, for those who notice.
* [once] [earn 1] Wring the dew out of the wing fabric, rag by rag -> dew
* [once] [has(orange)] Eat the orange, slowly, formally, a ceremony in two acts -> orange_rite
* [pay 1] Drink. One cup against the whole of the day. -> drink_dawn
* [white reckoning 9] Walk east-northeast, by the sun and the map in your head -> walk_end | wrong_way
* [has(chart)] Follow the chart's one legible corner -> walk_end
* [heart >= 5] Walk toward the thing that is not quite hope, but is shaped like it -> heart_end
* Stay with her. At dusk, burn a wing: petrol and fabric, a signature in smoke. -> stay_end

== dew
Half a cup of water that tastes of dope and varnish and aluminum. You drink the airplane's sweat and are grateful to her.
-> dawn

== orange_rite
~ take orange
You divide it with a pocketknife into perfect halves, and the smell of it is so loud in that empty country that both of you laugh. Men condemned to die do not get oranges. Therefore you are not condemned.
~ set resolve = resolve + 1
heart: Remember this. Whatever happens after, you were given an orange in the desert, and it was enough.
-> dawn

== drink_dawn
One cup. You hold each swallow against the roof of your mouth until it disappears on its own.
~ set resolve = resolve + 1
-> dawn

== wrong_way
Two hours out, the sun swings wrong across your shoulders. The map in your head has a fold in it somewhere. You correct, walking your doubt back to the wreck in a long shamed curve.
~ set resolve = resolve - 1
reckoning: East-northeast. You drifted with your feet exactly as you drifted with your wings.
-> dawn

== walk_end
You fill your pockets: raisins, the thermos with its {water} cups, the rags still damp with dew. And you walk, and the plateau lets you, one black pebble at a time.
THE LOGBOOK SAYS: YOU WALKED EAST. Somewhere ahead of you, days out, there is a rider on a camel who has already, without knowing it, begun to save your life.
-> END

== heart_end
There is a direction that pulls. It has no bearing and no excuse. Marchand looks at you, and shrugs, and falls in beside you, because a man who follows something is easier to follow than a man who follows nothing.
THE LOGBOOK SAYS: NOT HOPE, EXACTLY. But it walked like hope, and you walked behind it.
-> END

== stay_end
All day you build the pyre on the wing and do not light it. At dusk you light it. The fabric goes up with a sound like an enormous page turning, and the smoke stands straight up in the dead evening air, a black line a hundred meters tall. It is the largest thing you have ever written.
THE LOGBOOK SAYS: THE FIRE. If anyone is looking, they will see it. You sit with Marchand in the firelight and are, for one hour, the only lamp in a thousand square kilometers.
-> END
`;
