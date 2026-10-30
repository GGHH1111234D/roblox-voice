import bpy
import os

output_dir = r"C:\Users\GHASSAN\Documents\WebRTCSpatialVoice\models\modular_kit"
os.makedirs(output_dir, exist_ok=True)

# 1. Plain Modular Wall
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 2))
wall = bpy.context.active_object
wall.scale = (4, 0.4, 4)
bpy.ops.object.transform_apply(scale=True)
wall.name = "ModularWall_Plain"
bpy.ops.wm.obj_export(filepath=os.path.join(output_dir, "ModularWall_Plain.obj"))

# 2. Modular Window Wall
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(-1.3, 0, 2))
p1 = bpy.context.active_object
p1.scale = (1.4, 0.4, 4)
bpy.ops.mesh.primitive_cube_add(size=1, location=(1.3, 0, 2))
p2 = bpy.context.active_object
p2.scale = (1.4, 0.4, 4)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
p3 = bpy.context.active_object
p3.scale = (1.2, 0.4, 1)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 3.5))
p4 = bpy.context.active_object
p4.scale = (1.2, 0.4, 1)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.join()
win_wall = bpy.context.active_object
win_wall.name = "ModularWall_Window"
bpy.ops.object.transform_apply(scale=True)
bpy.ops.wm.obj_export(filepath=os.path.join(output_dir, "ModularWall_Window.obj"))

# 3. Architectural Pillar
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cylinder_add(radius=0.4, depth=4, location=(0, 0, 2))
col = bpy.context.active_object
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.2))
base = bpy.context.active_object
base.scale = (1.1, 1.1, 0.4)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 3.8))
top = bpy.context.active_object
top.scale = (1.1, 1.1, 0.4)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.join()
pillar = bpy.context.active_object
pillar.name = "Modular_Pillar"
bpy.ops.object.transform_apply(scale=True)
bpy.ops.wm.obj_export(filepath=os.path.join(output_dir, "Modular_Pillar.obj"))

# 4. Modular Sidewalk & Curb
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.2))
curb = bpy.context.active_object
curb.scale = (4, 2, 0.4)
bpy.ops.object.transform_apply(scale=True)
curb.name = "Modular_Sidewalk"
bpy.ops.wm.obj_export(filepath=os.path.join(output_dir, "Modular_Sidewalk.obj"))

print("SUCCESS_MODULAR_EXPORT_DONE")
